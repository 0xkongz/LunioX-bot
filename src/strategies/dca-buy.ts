import { BaseStrategy, TradeDecision } from "./base";
import { randomize } from "../utils/random";
import { logger } from "../utils/logger";

/**
 * DCA Buy Strategy
 *
 * Goal: Gradually accumulate the token, pushing the price up over time.
 * - Majority of trades are buys (controlled by dcaBiasPercent)
 * - Occasional sells to maintain natural-looking activity
 * - Distributes across wallets to look organic
 * - Respects daily volume target
 */
export class DCABuyStrategy extends BaseStrategy {
  decide(): TradeDecision {
    const tokenName = this.tokenConfig.name;

    const todayVolume = this.tracker.getTodayVolumeUsd(tokenName);
    if (todayVolume >= this.params.dailyVolumeTargetUsd) {
      return {
        shouldTrade: false,
        direction: "buy",
        amountUsd: 0,
        walletIndex: 0,
        reason: `Daily volume target reached: $${todayVolume.toFixed(2)}`,
      };
    }

    const buyProbability = this.params.dcaBiasPercent / 100;
    const direction: "buy" | "sell" =
      Math.random() < buyProbability ? "buy" : "sell";

    let amountUsd = randomize(
      this.params.tradeAmountUsd,
      this.params.variancePercent
    );

    if (direction === "sell") {
      amountUsd *= 0.6;
    }

    const wallet = this.walletGroup.nextRoundRobin();
    const today = this.tracker.getToday(tokenName);

    logger.debug(
      `[DCA Buy] ${tokenName} | Direction: ${direction} | ` +
        `Amount: $${amountUsd.toFixed(2)} | ` +
        `Today buys: $${today.totalBuyUsd.toFixed(2)} sells: $${today.totalSellUsd.toFixed(2)} | ` +
        `Wallet: ${wallet.label}`
    );

    return {
      shouldTrade: true,
      direction,
      amountUsd,
      walletIndex: wallet.index,
      reason: `DCA buy — bias ${this.params.dcaBiasPercent}% | ${direction}`,
    };
  }
}
