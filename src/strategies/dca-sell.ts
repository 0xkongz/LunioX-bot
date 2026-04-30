import { BaseStrategy, TradeDecision } from "./base";
import { randomize } from "../utils/random";
import { logger } from "../utils/logger";

/**
 * DCA Sell Strategy
 *
 * Goal: Gradually distribute/sell the token while maintaining activity.
 * - Majority of trades are sells (controlled by dcaBiasPercent)
 * - Occasional buys to maintain natural-looking activity
 * - Distributes across wallets
 * - Respects daily volume target
 */
export class DCASellStrategy extends BaseStrategy {
  decide(): TradeDecision {
    const tokenName = this.tokenConfig.name;

    const todayVolume = this.tracker.getTodayVolumeUsd(tokenName);
    if (todayVolume >= this.params.dailyVolumeTargetUsd) {
      return {
        shouldTrade: false,
        direction: "sell",
        amountUsd: 0,
        walletIndex: 0,
        reason: `Daily volume target reached: $${todayVolume.toFixed(2)}`,
      };
    }

    const sellProbability = this.params.dcaBiasPercent / 100;
    const direction: "buy" | "sell" =
      Math.random() < sellProbability ? "sell" : "buy";

    let amountUsd = randomize(
      this.params.tradeAmountUsd,
      this.params.variancePercent
    );

    if (direction === "buy") {
      amountUsd *= 0.6;
    }

    const wallet = this.walletGroup.nextRoundRobin();
    const today = this.tracker.getToday(tokenName);

    logger.debug(
      `[DCA Sell] ${tokenName} | Direction: ${direction} | ` +
        `Amount: $${amountUsd.toFixed(2)} | ` +
        `Today buys: $${today.totalBuyUsd.toFixed(2)} sells: $${today.totalSellUsd.toFixed(2)} | ` +
        `Wallet: ${wallet.label}`
    );

    return {
      shouldTrade: true,
      direction,
      amountUsd,
      walletIndex: wallet.index,
      reason: `DCA sell — bias ${this.params.dcaBiasPercent}% | ${direction}`,
    };
  }
}
