import { BaseStrategy, TradeDecision } from "./base";
import { randomize } from "../utils/random";
import { logger } from "../utils/logger";

/**
 * Delta Neutral Strategy
 *
 * Goal: Generate trading volume while keeping the daily net position near zero.
 * - Alternates buys and sells across wallets
 * - Tracks cumulative buy/sell amounts per day
 * - Biases direction to correct any imbalance
 * - At end of day window, executes a rebalance trade if needed
 */
export class DeltaNeutralStrategy extends BaseStrategy {
  decide(): TradeDecision {
    const tokenName = this.tokenConfig.name;

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

    const direction = this.tracker.getDeltaNeutralDirection(tokenName);

    const amountUsd = randomize(
      this.params.tradeAmountUsd,
      this.params.variancePercent
    );

    const netUsd = this.tracker.getTodayNetUsd(tokenName);
    let adjustedAmount = amountUsd;

    if (direction === "sell" && netUsd > 0) {
      adjustedAmount = Math.min(amountUsd, netUsd + this.params.tradeAmountUsd * 0.5);
    } else if (direction === "buy" && netUsd < 0) {
      adjustedAmount = Math.min(
        amountUsd,
        Math.abs(netUsd) + this.params.tradeAmountUsd * 0.5
      );
    }

    const wallet = this.walletGroup.nextRoundRobin();

    logger.debug(
      `[DeltaNeutral] ${tokenName} | Direction: ${direction} | ` +
        `Amount: $${adjustedAmount.toFixed(2)} | Net: $${netUsd.toFixed(2)} | ` +
        `Wallet: ${wallet.label}`
    );

    return {
      shouldTrade: true,
      direction,
      amountUsd: adjustedAmount,
      walletIndex: wallet.index,
      reason: `Delta neutral trade — net position: $${netUsd.toFixed(2)}`,
    };
  }
}
