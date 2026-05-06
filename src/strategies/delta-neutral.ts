import { TokenConfig, TradingParams } from "../config";
import { TokenWalletGroup } from "../core/wallet-manager";
import { DailyTracker } from "../core/tracker";
import { SwapService } from "../services/swap";
import { PriceFeed } from "../services/price-feed";
import { WeeklyAnchor } from "../services/weekly-anchor";
import { BaseStrategy, TradeDecision } from "./base";
import { gaussian, exponential } from "../utils/random";
import { logger } from "../utils/logger";

/**
 * Delta Neutral with weekly cycle + natural drift.
 *
 * - Daily target rolled at 00:00 UTC by WeeklyAnchor (1–5% drift biased
 *   toward Monday's anchor).
 * - Direction probability per trade biased toward today's target with a
 *   ±0.3 clamp so ≥20% of trades remain counter-direction.
 * - Trade size sampled from a gaussian distribution (replaces uniform).
 * - Inter-trade interval sampled from an exponential distribution
 *   (replaces uniform jitter — produces Poisson arrival pattern).
 * - Once in a while, the strategy enters a 30–60 min "quiet period"
 *   during which all ticks are skipped.
 *
 * The volume-target check is preserved at the top: if today's volume
 * has hit the target, the bot stops trading until the next daily roll.
 */
export class DeltaNeutralStrategy extends BaseStrategy {
  /** In-memory only — quiet periods don't survive restarts. */
  private quietUntil = 0;
  private anchor: WeeklyAnchor;

  constructor(
    tokenConfig: TokenConfig,
    params: TradingParams,
    walletGroup: TokenWalletGroup,
    tracker: DailyTracker,
    swapService: SwapService,
    priceFeed: PriceFeed,
    anchor: WeeklyAnchor
  ) {
    super(tokenConfig, params, walletGroup, tracker, swapService, priceFeed);
    this.anchor = anchor;
  }

  decide(): TradeDecision {
    const tokenName = this.tokenConfig.name;
    const now = Date.now();

    // ── Quiet period gate ─────────────────────────────────────────
    if (this.quietUntil > now) {
      return {
        shouldTrade: false,
        direction: "buy",
        amountUsd: 0,
        walletIndex: 0,
        reason: `Quiet period — resumes in ${Math.round((this.quietUntil - now) / 1000)}s`,
      };
    }

    // ── Daily volume target ───────────────────────────────────────
    const todayVolume = this.tracker.getTodayVolumeUsd(tokenName);
    if (todayVolume >= this.params.dailyVolumeTargetUsd) {
      return {
        shouldTrade: false,
        direction: "buy",
        amountUsd: 0,
        walletIndex: 0,
        reason: `Daily volume target reached: $${todayVolume.toFixed(2)} / $${this.params.dailyVolumeTargetUsd}`,
      };
    }

    // ── Roll for a new quiet period ───────────────────────────────
    if (Math.random() < this.params.quietPeriodProbability) {
      const minutes = 30 + Math.random() * 30; // 30–60 min
      this.quietUntil = now + minutes * 60 * 1000;
      logger.info(
        `[DeltaNeutral] ${tokenName} entering quiet period for ${minutes.toFixed(0)} min`
      );
      return {
        shouldTrade: false,
        direction: "buy",
        amountUsd: 0,
        walletIndex: 0,
        reason: "Quiet period — trader stepped away",
      };
    }

    // ── Direction: bias toward today's target ─────────────────────
    const state = this.anchor.getState();
    const today = state.today;
    if (!today) {
      // Anchor not yet bootstrapped — skip this tick; engine's next
      // tick() call will bootstrap.
      return {
        shouldTrade: false,
        direction: "buy",
        amountUsd: 0,
        walletIndex: 0,
        reason: "Weekly anchor not yet initialized",
      };
    }

    // Read price from the synchronous cache. priceFeed.getPrice() is async
    // and used by the engine to keep this cache warm; we can't await here
    // because decide() is sync. If the cache is empty (very first tick
    // before any price refresh), fall back to today.open so direction is
    // neutral (r ≈ 0) and we avoid a one-sided burst on first run.
    const cached = this.priceFeed
      .getAllPrices()
      .find(
        (p) =>
          p.tokenAddress.toLowerCase() ===
          this.tokenConfig.address.toLowerCase()
      );
    const price = cached?.priceUsd ?? today.open;

    const r = price === 0 ? 0 : (today.target - price) / price;
    const pBuy = this.anchor.directionProbabilityForTrade(r);
    const direction: "buy" | "sell" = Math.random() < pBuy ? "buy" : "sell";

    // ── Size: gaussian around tradeAmountUsd ──────────────────────
    const sigma = this.params.tradeSizeSigma;
    const factor = 1 + gaussian(0, sigma);
    const clamped = Math.max(0.5, Math.min(2.0, factor));
    const amountUsd = this.params.tradeAmountUsd * clamped;

    // ── Wallet: round-robin (pre-flight balance check is in base) ─
    const wallet = this.walletGroup.nextRoundRobin();

    logger.debug(
      `[DeltaNeutral] ${tokenName} | dir=${direction} P(buy)=${pBuy.toFixed(2)} ` +
        `r=${(r * 100).toFixed(2)}% | size=$${amountUsd.toFixed(2)} | wallet=${wallet.label}`
    );

    return {
      shouldTrade: true,
      direction,
      amountUsd,
      walletIndex: wallet.index,
      reason: `Natural drift — target $${today.target.toFixed(6)}, current $${price.toFixed(6)}, P(buy)=${pBuy.toFixed(2)}`,
    };
  }

  /**
   * Inter-trade interval drawn from an exponential distribution
   * (Poisson arrivals), clamped to [30s, 3×base].
   */
  override nextIntervalMs(): number {
    const base = this.params.intervalSeconds;
    const sample = exponential(base);
    const clamped = Math.max(30, Math.min(3 * base, sample));
    return clamped * 1000;
  }
}
