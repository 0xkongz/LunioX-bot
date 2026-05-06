import * as fs from "fs";
import * as path from "path";
import { TradingParams } from "../config";
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

interface AnchorFile {
  version: 1;
  anchor: AnchorRecord | null;
  today: TodayRecord | null;
}

const EMPTY: AnchorFile = { version: 1, anchor: null, today: null };

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
   * Compute today's target price = today.open × (1 + signedDrift), where
   * signed drift is rolled with anchor-pull bias on direction and uniform
   * random magnitude.
   */
  private computeTarget(open: number, anchorPrice: number): number {
    const d = anchorPrice === 0 ? 0 : (open - anchorPrice) / anchorPrice;
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
      const parsed = JSON.parse(raw);
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
  private isValidAnchorFile(v: any): v is AnchorFile {
    if (!v || typeof v !== "object") return false;
    if (v.version !== 1) return false;
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
