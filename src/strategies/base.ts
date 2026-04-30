import { TokenConfig, TradingParams } from "../config";
import { TokenWalletGroup } from "../core/wallet-manager";
import { DailyTracker } from "../core/tracker";
import { SwapService, SwapResult } from "../services/swap";
import { PriceFeed } from "../services/price-feed";
import { PriceUnavailableError } from "../services/errors";

export interface TradeDecision {
  shouldTrade: boolean;
  direction: "buy" | "sell";
  amountUsd: number;
  walletIndex: number; // global wallet index
  reason: string;
}

export abstract class BaseStrategy {
  protected tokenConfig: TokenConfig;
  protected params: TradingParams;
  protected walletGroup: TokenWalletGroup;
  protected tracker: DailyTracker;
  protected swapService: SwapService;
  protected priceFeed: PriceFeed;

  constructor(
    tokenConfig: TokenConfig,
    params: TradingParams,
    walletGroup: TokenWalletGroup,
    tracker: DailyTracker,
    swapService: SwapService,
    priceFeed: PriceFeed
  ) {
    this.tokenConfig = tokenConfig;
    this.params = params;
    this.walletGroup = walletGroup;
    this.tracker = tracker;
    this.swapService = swapService;
    this.priceFeed = priceFeed;
  }

  abstract decide(): TradeDecision;

  async execute(decision: TradeDecision): Promise<SwapResult | null> {
    if (!decision.shouldTrade) return null;

    const wallet = this.walletGroup.get(decision.walletIndex);
    let amountIn: bigint;
    try {
      amountIn =
        decision.direction === "buy"
          ? this.swapService.amountFromUsd(
              decision.amountUsd,
              this.tokenConfig.pairDecimals
            )
          : await this.priceFeed.usdToTokenAmount(
              decision.amountUsd,
              this.tokenConfig
            );
    } catch (err: any) {
      if (err instanceof PriceUnavailableError) {
        return null;
      }
      throw err;
    }

    const result = await this.swapService.executeSwap(
      wallet.wallet,
      this.tokenConfig,
      amountIn,
      decision.direction,
      this.params.maxSlippageBps,
      this.params.maxPriceImpactBps
    );

    this.tracker.recordTrade(result, decision.amountUsd);
    return result;
  }

  /** Update params at runtime (from dashboard) */
  updateParams(params: Partial<TradingParams>): void {
    Object.assign(this.params, params);
  }

  getParams(): TradingParams {
    return { ...this.params };
  }

  /** Replace the cached token config (used after a registry update). */
  updateTokenConfig(tokenConfig: TokenConfig): void {
    this.tokenConfig = tokenConfig;
  }
}
