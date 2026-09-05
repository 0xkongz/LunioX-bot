import * as fs from "fs";
import * as path from "path";
import { TargetPriceUnit, TradingParams } from "../config";
import { targetPriceUsd } from "../strategies/price-defense";
import { logger } from "../utils/logger";

/**
 * Source of "current price" for the token. Decoupled from PriceFeed so
 * tests can pass a stub.
 */
export type PriceSource = () => number | Promise<number>;

interface AnchorRecord {
  price: number;
  setAt: string; // ISO timestamp
}

interface TodayRecord {
  open: number;
  target: number;
  openedAt: string; // ISO timestamp
}

/**
 * Set once a "reach"-mode target has been hit. Carries the goal it was
 * recorded against so that moving the target re-arms the defense instead
 * of leaving it permanently stood down.
 */
interface ReachedRecord {
  price: number;
  unit: TargetPriceUnit;
  at: string; // ISO timestamp
}

interface AnchorFile {
  version: 2;
  anchor: AnchorRecord | null;
  today: TodayRecord | null;
  /** Non-null only in "reach" mode, once the target has been touched. */
  reached: ReachedRecord | null;
}

const EMPTY: AnchorFile = {
  version: 2,
  anchor: null,
  today: null,
  reached: null,
};

/**
 * Per-token weekly anchor + daily drift target manager.
 *
 * Persists state to <dataDir>/<tokenKey>.json. The engine constructs one
 * instance per delta_neutral token and calls tick() once per minute.
 *
 * tick() is idempotent: it checks the current persisted timestamps before
 * doing any rolls. Calling it twice in the same minute is a no-op.
 */
export class WeeklyAnchor {
  private filePath: string;
  private state: AnchorFile;
  private priceSource: PriceSource;
  private params: TradingParams;
  readonly tokenKey: string;
  /**
   * Which side of the target the price was last seen on (-1 above, +1
   * below, 0 unknown). In-memory only: it exists to catch a price that
   * jumps clean over the tolerance band between two ticks, and a restart
   * simply re-learns it on the next observation.
   */
  private targetSide = 0;

  constructor(
    tokenKey: string,
    dataDir: string,
    priceSource: PriceSource,
    params: TradingParams
  ) {
    this.tokenKey = tokenKey;
    this.priceSource = priceSource;
    this.params = params;
    this.filePath = path.join(dataDir, `${tokenKey}.json`);
    this.ensureDir(dataDir);
    this.state = this.loadFromDisk();
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Current state snapshot — for dashboard reads and tests. */
  getState(): AnchorFile {
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Adopt a runtime param change. The engine hands the anchor the same
   * params object the strategy holds, so this is normally a no-op — but a
   * caller that passes a detached copy still needs a way to keep the
   * anchor in step, and tests rely on it.
   */
  updateParams(patch: Partial<TradingParams>): void {
    Object.assign(this.params, patch);
  }

  /**
   * Run lifecycle checks for the current minute. Idempotent.
   *
   *   - First-run: no anchor → snapshot price as anchor + today.open + roll target
   *   - New day: today.openedAt is from prior UTC date → roll today fresh
   *   - New week: anchor.setAt is from before current week's Monday → reset anchor
   */
  tick(now: Date = new Date()): void {
    // Weekly reset takes precedence — must happen before daily roll, so the
    // daily roll uses the freshly-set anchor.
    if (this.shouldResetAnchor(now)) {
      this.snapshotAnchor(now);
    }
    if (this.shouldRollToday(now)) {
      this.rollToday(now);
    }
    if (!this.state.anchor || !this.state.today) {
      // First-run path or partial state — fully bootstrap.
      this.bootstrap(now);
    }
  }

  /**
   * Operator-triggered hard reset. Snapshots current price as new anchor +
   * today.open and rolls fresh target. Used by the dashboard reset button.
   */
  resetAnchor(now: Date = new Date()): void {
    this.snapshotAnchor(now);
    this.rollToday(now);
  }

  /**
   * Probability of "up" direction for the daily target roll, given the
   * current price's distance from anchor.
   */
  directionProbabilityForRoll(distanceFromAnchor: number): number {
    return this.clamp(
      0.5 - distanceFromAnchor * this.params.anchorPullStrength,
      0.1,
      0.9
    );
  }

  /**
   * Probability of "buy" for an individual trade, given current
   * drift-remaining (signed fraction: positive = need to push up).
   */
  directionProbabilityForTrade(driftRemaining: number): number {
    const bias = this.clamp(
      driftRemaining * this.params.biasStrength,
      -0.3,
      0.3
    );
    return 0.5 + bias;
  }

  /**
   * The anchor's contribution to P(buy), as an additive bias around 0
   * rather than a probability. The price defense adds its own term on top,
   * so the two signals have to compose; returning a bias keeps the 0.5
   * baseline in one place (buyProbability) instead of two.
   */
  directionBiasForTrade(driftRemaining: number): number {
    return this.directionProbabilityForTrade(driftRemaining) - 0.5;
  }

  // ─── Reach mode ──────────────────────────────────────────────────

  /**
   * The recorded arrival for the *currently configured* goal, or null.
   *
   * Matching on price and unit is what makes a retarget re-arm the
   * defense: a stale record from a previous goal never counts, so the
   * operator moving the target does not silently leave the bot stood down.
   */
  targetReached(): ReachedRecord | null {
    const r = this.state.reached;
    if (!r) return null;
    if (this.params.targetPriceMode !== "reach") return null;
    const goal = this.params.targetPrice ?? 0;
    if (!goal || goal <= 0) return null;
    const unit = this.params.targetPriceUnit ?? "USD_PER_TOKEN";
    if (r.price !== goal || r.unit !== unit) return null;
    return r;
  }

  /**
   * The params the strategy should actually trade on. Identical to the
   * configured params except in reach mode after arrival, where the target
   * is zeroed — which switches the price defense off and leaves the token
   * trading pure delta-neutral around wherever it landed.
   */
  effectiveParams(): TradingParams {
    if (!this.targetReached()) return this.params;
    return { ...this.params, targetPrice: 0 };
  }

  /**
   * Feed the live price in so reach mode can notice arrival. No-op in hold
   * mode, with no target set, or once already recorded.
   *
   * Arrival counts either when the price lands inside the tolerance band
   * or when it crosses the target outright — a thin pool can gap straight
   * over a 1% band in a single trade, and without the crossing check the
   * bot would keep pushing a price that already overshot.
   */
  observePrice(priceUsd: number, now: Date = new Date()): void {
    if (this.params.targetPriceMode !== "reach") {
      this.targetSide = 0;
      return;
    }
    const goal = this.params.targetPrice ?? 0;
    if (!goal || goal <= 0) {
      this.targetSide = 0;
      return;
    }
    if (this.targetReached()) return;

    const target = targetPriceUsd(this.params);
    if (!target || !(priceUsd > 0)) return;

    const dev = target / priceUsd - 1; // > 0: below target, < 0: above
    const side = dev > 0 ? 1 : -1;
    const tolerance = (this.params.targetPriceReachedTolerancePct ?? 0) / 100;
    const within = Math.abs(dev) <= tolerance;
    const crossed = this.targetSide !== 0 && side !== this.targetSide;

    if (!within && !crossed) {
      this.targetSide = side;
      return;
    }

    this.state.reached = {
      price: goal,
      unit: this.params.targetPriceUnit ?? "USD_PER_TOKEN",
      at: now.toISOString(),
    };
    this.targetSide = 0;
    this.saveToDisk();
    logger.info(
      `[WeeklyAnchor:${this.tokenKey}] Target price reached (${priceUsd} vs ${target}) — ` +
        `skew disengaged, continuing delta-neutral`
    );
  }

  /**
   * Forget any recorded arrival and re-arm the defense. Called when the
   * operator changes the goal or flips the mode.
   */
  clearTargetReached(): void {
    this.targetSide = 0;
    if (!this.state.reached) return;
    this.state.reached = null;
    this.saveToDisk();
    logger.info(`[WeeklyAnchor:${this.tokenKey}] Reach-state cleared — defense re-armed`);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  /** Synchronous price snapshot for tick paths. Async sources unsupported here. */
  private readPriceSync(): number {
    const v = this.priceSource();
    if (typeof v === "number") return v;
    throw new Error(
      "WeeklyAnchor requires a synchronous price source for tick paths"
    );
  }

  private bootstrap(now: Date): void {
    const price = this.readPriceSync();
    if (!this.state.anchor) {
      this.state.anchor = { price, setAt: now.toISOString() };
    }
    this.state.today = {
      open: price,
      target: this.computeTarget(price, this.state.anchor!.price),
      openedAt: now.toISOString(),
    };
    this.saveToDisk();
    logger.info(
      `[WeeklyAnchor:${this.tokenKey}] Bootstrapped: anchor=${this.state.anchor.price}, today.target=${this.state.today.target}`
    );
  }

  private snapshotAnchor(now: Date): void {
    const price = this.readPriceSync();
    this.state.anchor = { price, setAt: now.toISOString() };
    this.saveToDisk();
    logger.info(
      `[WeeklyAnchor:${this.tokenKey}] Anchor reset to ${price} at ${now.toISOString()}`
    );
  }

  private rollToday(now: Date): void {
    const price = this.readPriceSync();
    const anchor = this.state.anchor?.price ?? price;
    this.state.today = {
      open: price,
      target: this.computeTarget(price, anchor),
      openedAt: now.toISOString(),
    };
    this.saveToDisk();
    logger.info(
      `[WeeklyAnchor:${this.tokenKey}] Daily roll: open=${price}, target=${this.state.today.target}`
    );
  }

  /**
   * The price the daily drift is pulled back toward.
   *
   * With no defense configured this is Monday's anchor, and the token
   * wanders wherever the week takes it. With a target set, the target
   * becomes the centre of gravity instead — which is the whole point of
   * the defense: a day that opens 20% under the target rolls its drift
   * upward with near-certainty, rather than treating the sold-off price
   * as the new normal the way an anchor re-based to today's open does.
   *
   * In reach mode after arrival the target is already zeroed out by
   * effectiveParams(), so this falls back to the anchor on its own.
   */
  private gravityPrice(anchorPrice: number): number {
    return targetPriceUsd(this.effectiveParams()) || anchorPrice;
  }

  /**
   * Compute today's target price = today.open × (1 + signedDrift), where
   * signed drift is rolled with gravity-pull bias on direction and uniform
   * random magnitude.
   */
  private computeTarget(open: number, anchorPrice: number): number {
    const gravity = this.gravityPrice(anchorPrice);
    const d = gravity === 0 ? 0 : (open - gravity) / gravity;
    const pUp = this.directionProbabilityForRoll(d);
    const sign = Math.random() < pUp ? 1 : -1;
    const minPct = this.params.dailyDriftMinPct / 100;
    const maxPct = this.params.dailyDriftMaxPct / 100;
    const magnitude = minPct + Math.random() * (maxPct - minPct);
    return open * (1 + sign * magnitude);
  }

  private shouldResetAnchor(now: Date): boolean {
    if (!this.state.anchor) return false; // bootstrap path handles first run
    const lastSetAt = new Date(this.state.anchor.setAt);
    return this.mondayUtcOf(now).getTime() > lastSetAt.getTime();
  }

  private shouldRollToday(now: Date): boolean {
    if (!this.state.today) return false; // bootstrap path
    const lastOpenedAt = new Date(this.state.today.openedAt);
    return !this.sameUtcDay(lastOpenedAt, now);
  }

  /** The UTC Monday 00:00 of the week containing `now`. */
  private mondayUtcOf(now: Date): Date {
    const utcDay = now.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
    const daysSinceMonday = (utcDay + 6) % 7; // Mon → 0, Tue → 1, ..., Sun → 6
    const monday = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysSinceMonday,
        0,
        0,
        0,
        0
      )
    );
    return monday;
  }

  private sameUtcDay(a: Date, b: Date): boolean {
    return (
      a.getUTCFullYear() === b.getUTCFullYear() &&
      a.getUTCMonth() === b.getUTCMonth() &&
      a.getUTCDate() === b.getUTCDate()
    );
  }

  private clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
  }

  // ─── Disk I/O (atomic write, same pattern as tracker.ts) ──────────

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err: any) {
      logger.error(
        `[WeeklyAnchor:${this.tokenKey}] mkdir failed: ${err.message}`
      );
    }
  }

  private loadFromDisk(): AnchorFile {
    if (!fs.existsSync(this.filePath)) {
      return { ...EMPTY };
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = this.migrate(JSON.parse(raw));
      if (!this.isValidAnchorFile(parsed)) {
        logger.warn(
          `[WeeklyAnchor:${this.tokenKey}] invalid shape in ${this.filePath}, resetting`
        );
        return { ...EMPTY };
      }
      return parsed;
    } catch (err: any) {
      logger.error(
        `[WeeklyAnchor:${this.tokenKey}] load failed: ${err.message}`
      );
      return { ...EMPTY };
    }
  }

  /**
   * Structural validator for the on-disk file. Rejects malformed JSON that
   * happens to have the right `version` field but wrong shape for `anchor`
   * or `today` — without this, downstream code would crash on the first
   * field access. anchor/today may be null (uninitialized state); when
   * present they must have all expected fields with correct types.
   */
  /**
   * Bring a file written by an older build up to the current shape.
   *
   * v1 predates the price defense and simply has no `reached` field.
   * Discarding those files instead would throw away a live weekly anchor
   * on the deploy that ships this change, re-basing every token to
   * whatever the price happened to be at restart.
   */
  private migrate(v: any): any {
    if (!v || typeof v !== "object") return v;
    if (v.version === 1) {
      return { ...v, version: 2, reached: null };
    }
    return v;
  }

  private isValidAnchorFile(v: any): v is AnchorFile {
    if (!v || typeof v !== "object") return false;
    if (v.version !== 2) return false;
    if (v.reached !== null && v.reached !== undefined) {
      if (
        typeof v.reached !== "object" ||
        typeof v.reached.price !== "number" ||
        typeof v.reached.unit !== "string" ||
        typeof v.reached.at !== "string"
      ) {
        return false;
      }
    }
    if (v.anchor !== null) {
      if (
        !v.anchor ||
        typeof v.anchor !== "object" ||
        typeof v.anchor.price !== "number" ||
        typeof v.anchor.setAt !== "string"
      ) {
        return false;
      }
    }
    if (v.today !== null) {
      if (
        !v.today ||
        typeof v.today !== "object" ||
        typeof v.today.open !== "number" ||
        typeof v.today.target !== "number" ||
        typeof v.today.openedAt !== "string"
      ) {
        return false;
      }
    }
    return true;
  }

  private saveToDisk(): void {
    const tmp = this.filePath + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err: any) {
      logger.error(
        `[WeeklyAnchor:${this.tokenKey}] save failed: ${err.message}`
      );
    }
  }
}
