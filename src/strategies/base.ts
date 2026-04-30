import { ethers } from "ethers";
import { TokenConfig, TradingParams } from "../config";
import { TokenWalletGroup, WalletInfo } from "../core/wallet-manager";
import { DailyTracker } from "../core/tracker";
import { SwapService, SwapResult } from "../services/swap";
import { PriceFeed } from "../services/price-feed";
import { PriceUnavailableError } from "../services/errors";
import { logger } from "../utils/logger";

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

    const initialWallet = this.walletGroup.get(decision.walletIndex);
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

    // Pre-flight balance check with wallet fallback. Without this we'd
    // sign and submit transactions that revert on-chain — wasted gas
    // plus a long red trail in BscScan that defeats the point of
    // mixed-direction DCA. If the round-robin wallet doesn't have
    // enough of the input token, we walk the group looking for one
    // that does. If none qualify, we skip this tick silently.
    const wallet = await this.findSolventWallet(
      initialWallet,
      amountIn,
      decision.direction
    );
    if (!wallet) {
      const tokenLabel =
        decision.direction === "buy" ? "USDT" : this.tokenConfig.name;
      const decimals =
        decision.direction === "buy"
          ? this.tokenConfig.pairDecimals
          : this.tokenConfig.decimals;
      logger.warn(
        `[${this.tokenConfig.name}] Skipping ${decision.direction} — ` +
          `no wallet in group has ${ethers.formatUnits(amountIn, decimals)} ${tokenLabel}. ` +
          `Top up wallets or lower trade size.`
      );
      return null;
    }

    if (wallet.index !== initialWallet.index) {
      logger.info(
        `[${this.tokenConfig.name}] Wallet ${initialWallet.label} insufficient — falling back to ${wallet.label}`
      );
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

  /**
   * Find a wallet in the group that has enough of the input token to
   * cover `amountIn`. Tries `preferred` first (the one decide() picked
   * via round-robin), then falls back to the rest of the group.
   *
   * Returns null if no wallet has enough — caller should skip the
   * trade rather than submit a doomed tx.
   */
  private async findSolventWallet(
    preferred: WalletInfo,
    amountIn: bigint,
    direction: "buy" | "sell"
  ): Promise<WalletInfo | null> {
    const inputToken =
      direction === "buy"
        ? this.tokenConfig.pairToken
        : this.tokenConfig.address;

    // Build candidate list: preferred wallet first, then the rest of
    // the group in their natural order. We don't shuffle — preserving
    // determinism makes the logs easier to follow when debugging.
    const all = this.walletGroup.getAll();
    const candidates: WalletInfo[] = [preferred];
    for (const w of all) {
      if (w.index !== preferred.index) candidates.push(w);
    }

    for (const w of candidates) {
      try {
        const balance = await this.swapService.getTokenBalance(
          w.address,
          inputToken
        );
        if (balance >= amountIn) return w;
      } catch (err: any) {
        // RPC blip — try next wallet rather than aborting the whole tick.
        logger.debug(
          `[${this.tokenConfig.name}] Balance read failed for ${w.label}: ${err.message ?? err}`
        );
      }
    }
    return null;
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
