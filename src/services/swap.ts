import {
  ethers,
  Wallet,
  Contract,
  JsonRpcProvider,
  Interface,
  Log,
} from "ethers";
import { TokenConfig, AppConfig } from "../config";
import { logger } from "../utils/logger";

// ─── PancakeSwap V2 Router ABI ─────────────────────────────────────
//
// We use swapExactTokensForTokensSupportingFeeOnTransferTokens because
// some project tokens charge transfer taxes. For non-fee tokens this is
// equivalent to swapExactTokensForTokens; for fee tokens it does the
// right thing. getAmountsOut quotes any path (single- or multi-hop).
const V2_ROUTER_ABI = [
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

const V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
];

// V2 Pair Swap event — emitted on every swap by the pair contract.
const V2_PAIR_SWAP_EVENT =
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)";

const v2PairIface = new Interface([V2_PAIR_SWAP_EVENT]);
const V2_SWAP_TOPIC = ethers.id(
  "Swap(address,uint256,uint256,uint256,uint256,address)"
);

/** PancakeSwap V2 LP fee numerator/denominator: 0.25% fee → multiplier 9975/10000. */
const FEE_NUMERATOR = 9975n;
const FEE_DENOMINATOR = 10000n;

/** Allowance cache TTL — matches the SDK's 5-minute window. */
const ALLOWANCE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface SwapResult {
  success: boolean;
  txHash: string;
  amountIn: string;
  amountOut: string;
  direction: "buy" | "sell";
  tokenName: string;
  walletAddress: string;
  gasUsed: string;
  /** On-curve price impact in basis points (10000 = 100%). 0 if not computed. */
  priceImpactBps: number;
  error?: string;
}

interface AllowanceCacheEntry {
  /** Last observed allowance (raw bigint). */
  allowance: bigint;
  /** Wall-clock expiry. */
  expiresAt: number;
}

export class SwapService {
  private config: AppConfig;
  private provider: JsonRpcProvider;
  /**
   * Map of `${wallet}|${token}` → last-seen allowance. Avoids re-reading
   * `allowance()` on every swap when we've recently observed enough
   * headroom; saves ~1 RPC call per trade.
   */
  private allowanceCache: Map<string, AllowanceCacheEntry> = new Map();
  /** Cached pair.token0() lookups — immutable per pair. */
  private token0Cache: Map<string, string> = new Map();

  constructor(config: AppConfig, provider: JsonRpcProvider) {
    this.config = config;
    this.provider = provider;
  }

  // ─── Approval (with TTL cache) ────────────────────────────────────
  private allowanceKey(wallet: string, token: string): string {
    return `${wallet.toLowerCase()}|${token.toLowerCase()}`;
  }

  private async ensureApproval(
    wallet: Wallet,
    tokenAddress: string,
    amount: bigint
  ): Promise<void> {
    const key = this.allowanceKey(wallet.address, tokenAddress);
    const cached = this.allowanceCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now && cached.allowance >= amount) {
      // Cached headroom is enough; skip the RPC entirely.
      return;
    }

    const token = new Contract(tokenAddress, ERC20_ABI, wallet);
    const routerAddr = this.config.v2RouterAddress;
    const currentAllowance: bigint = await token.allowance(
      wallet.address,
      routerAddr
    );

    if (currentAllowance < amount) {
      logger.info(
        `Approving ${tokenAddress} for V2 Router (wallet: ${wallet.address})`
      );
      const tx = await token.approve(routerAddr, ethers.MaxUint256);
      await tx.wait();
      logger.info(`Approval confirmed: ${tx.hash}`);
      // After approving MaxUint256, treat the cache as effectively
      // unlimited for the TTL window.
      this.allowanceCache.set(key, {
        allowance: ethers.MaxUint256,
        expiresAt: now + ALLOWANCE_CACHE_TTL_MS,
      });
      return;
    }

    // Allowance was already sufficient — cache the observed value.
    this.allowanceCache.set(key, {
      allowance: currentAllowance,
      expiresAt: now + ALLOWANCE_CACHE_TTL_MS,
    });
  }

  /** Drop cached allowance for a (wallet, token) — used by tests. */
  clearAllowanceCache(): void {
    this.allowanceCache.clear();
  }

  async getTokenBalance(
    walletAddress: string,
    tokenAddress: string
  ): Promise<bigint> {
    const token = new Contract(tokenAddress, ERC20_ABI, this.provider);
    return token.balanceOf(walletAddress);
  }

  // ─── Path construction ─────────────────────────────────────────────
  /**
   * Build the V2 swap path for a buy (USDT → token) or sell (token →
   * USDT), accounting for the token's configured route. For wbnb-hop
   * tokens this routes through WBNB; for direct tokens it's a single hop.
   */
  private buildPath(
    tokenConfig: TokenConfig,
    direction: "buy" | "sell"
  ): string[] {
    const usdt = tokenConfig.pairToken;
    const token = tokenConfig.address;
    const wbnb = this.config.wbnbAddress;
    if (tokenConfig.route === "wbnb-hop") {
      return direction === "buy"
        ? [usdt, wbnb, token]
        : [token, wbnb, usdt];
    }
    return direction === "buy" ? [usdt, token] : [token, usdt];
  }

  /**
   * Pair addresses corresponding to each *hop* of the path. The order
   * mirrors `buildPath` so index i in `pairs` is the pair between
   * path[i] and path[i+1]. We use this to:
   *   - parse the actual amountOut from the final pair's Swap log
   *   - read reserves for the price-impact calculation
   */
  private buildPairPath(
    tokenConfig: TokenConfig,
    direction: "buy" | "sell"
  ): string[] {
    if (tokenConfig.route === "wbnb-hop") {
      // direct hops: [USDT-WBNB] then [WBNB-token] for buy, reversed for sell
      const wbnbUsdt = tokenConfig.wbnbUsdtPair;
      if (!wbnbUsdt) {
        throw new Error(
          `Token ${tokenConfig.key} is wbnb-hop but missing wbnbUsdtPair in registry`
        );
      }
      return direction === "buy"
        ? [wbnbUsdt, tokenConfig.pairAddress]
        : [tokenConfig.pairAddress, wbnbUsdt];
    }
    return [tokenConfig.pairAddress];
  }

  // ─── Price impact ──────────────────────────────────────────────────
  /**
   * Compute on-curve price impact for a multi-hop V2 swap.
   *
   * For a single hop the pure (fee-excluded) impact is:
   *   impact_i = amountIn_i / (reserveIn_i + amountIn_i)
   *
   * For multi-hop we chain hops: feed hop1's actual output into hop2 as
   * amountIn, accumulate impact multiplicatively. We use the V2 fee
   * formula to compute the *actual* output of each hop so impact_i
   * reflects the curve shape, not idealised constant-product.
   *
   * Returns impact in basis points (e.g. 250 = 2.5%).
   */
  private async computePriceImpactBps(
    pairPath: string[],
    path: string[],
    amountIn: bigint
  ): Promise<number> {
    if (pairPath.length === 0) return 0;
    let cumulativeImpact = 1.0; // 1.0 = no impact yet; we multiply (1 - hopImpact)
    let currentAmountIn = amountIn;

    for (let i = 0; i < pairPath.length; i++) {
      const pairAddr = pairPath[i];
      const tokenIn = path[i];
      const tokenOut = path[i + 1];

      const reserves = await this.readPairReserves(
        pairAddr,
        tokenIn,
        tokenOut
      );
      if (reserves.reserveIn === 0n || reserves.reserveOut === 0n) {
        return 10000; // Empty pair — treat as 100% impact (will block trade).
      }

      // hopImpact = amountIn / (reserveIn + amountIn)  (pure constant product)
      const denom = reserves.reserveIn + currentAmountIn;
      const hopImpact =
        denom === 0n ? 0 : Number(currentAmountIn) / Number(denom);
      cumulativeImpact *= 1 - hopImpact;

      // For chained hops, compute actual hop output (with fee) so the
      // next hop's reserveIn adjustment is realistic.
      const amountInWithFee = currentAmountIn * FEE_NUMERATOR;
      const numerator = amountInWithFee * reserves.reserveOut;
      const denominator =
        reserves.reserveIn * FEE_DENOMINATOR + amountInWithFee;
      currentAmountIn = denominator === 0n ? 0n : numerator / denominator;
    }
    const impact = 1 - cumulativeImpact;
    return Math.round(Math.max(0, Math.min(1, impact)) * 10000);
  }

  /**
   * Read a pair's reserves and split them into "in" / "out" sides for a
   * given hop direction. Caches token0() since it's immutable per pair.
   */
  private async readPairReserves(
    pairAddress: string,
    tokenIn: string,
    tokenOut: string
  ): Promise<{ reserveIn: bigint; reserveOut: bigint }> {
    const pair = new Contract(pairAddress, V2_PAIR_ABI, this.provider);
    const [r0, r1] = await pair.getReserves();
    let token0 = this.token0Cache.get(pairAddress.toLowerCase());
    if (!token0) {
      token0 = ((await pair.token0()) as string).toLowerCase();
      this.token0Cache.set(pairAddress.toLowerCase(), token0);
    }
    const inIsToken0 = tokenIn.toLowerCase() === token0;
    return {
      reserveIn: BigInt(inIsToken0 ? r0 : r1),
      reserveOut: BigInt(inIsToken0 ? r1 : r0),
    };
  }

  // ─── Swap Execution ───────────────────────────────────────────────
  async executeSwap(
    wallet: Wallet,
    tokenConfig: TokenConfig,
    amountIn: bigint,
    direction: "buy" | "sell",
    maxSlippageBps: number,
    maxPriceImpactBps: number = 10000
  ): Promise<SwapResult> {
    const path = this.buildPath(tokenConfig, direction);
    const pairPath = this.buildPairPath(tokenConfig, direction);
    const inputToken = path[0];
    const outputToken = path[path.length - 1];

    try {
      // ── Dry-run mode ────────────────────────────────────────────
      if (this.config.dryRun) {
        const decimals =
          direction === "buy" ? tokenConfig.pairDecimals : tokenConfig.decimals;
        const amountStr = ethers.formatUnits(amountIn, decimals);
        // Compute price impact even in dry-run so logs reflect what would
        // happen — useful for sanity-checking thin pools.
        let priceImpactBps = 0;
        try {
          priceImpactBps = await this.computePriceImpactBps(
            pairPath,
            path,
            amountIn
          );
        } catch (err: any) {
          logger.warn(`[DRY RUN] Price-impact calc failed: ${err.message}`);
        }
        logger.info(
          `[DRY RUN] Would ${direction} ${amountStr} ${direction === "buy" ? "USDT" : tokenConfig.name} via ${wallet.address} ` +
            `| route=${tokenConfig.route} | impact=${(priceImpactBps / 100).toFixed(2)}%`
        );
        return {
          success: true,
          txHash: `0xdryrun_${Date.now().toString(16)}`,
          amountIn: amountIn.toString(),
          amountOut: amountIn.toString(),
          direction,
          tokenName: tokenConfig.name,
          walletAddress: wallet.address,
          gasUsed: "0",
          priceImpactBps,
        };
      }

      // ── Gas price guard ─────────────────────────────────────────
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || 0n;
      const maxGasWei = ethers.parseUnits(
        this.config.maxGasPriceGwei.toString(),
        "gwei"
      );
      if (gasPrice > maxGasWei) {
        throw new Error(
          `Gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei exceeds max ${this.config.maxGasPriceGwei} gwei`
        );
      }

      // ── Price-impact guard ──────────────────────────────────────
      // Computed *before* we approve and submit the tx, so we never
      // pay gas on a trade we're going to refuse.
      const priceImpactBps = await this.computePriceImpactBps(
        pairPath,
        path,
        amountIn
      );
      if (priceImpactBps > maxPriceImpactBps) {
        throw new Error(
          `Price impact ${(priceImpactBps / 100).toFixed(2)}% exceeds limit ${(maxPriceImpactBps / 100).toFixed(2)}% — aborting (route=${tokenConfig.route})`
        );
      }

      // ── Ensure approval to V2 router (with cache) ───────────────
      await this.ensureApproval(wallet, inputToken, amountIn);

      // ── Quote min-out via getAmountsOut, then apply slippage ────
      const router = new Contract(
        this.config.v2RouterAddress,
        V2_ROUTER_ABI,
        wallet
      );

      const amountsOut: bigint[] = await router.getAmountsOut(amountIn, path);
      const expectedOut = amountsOut[amountsOut.length - 1];
      const amountOutMin =
        (expectedOut * BigInt(10000 - maxSlippageBps)) / 10000n;

      const inDecimals =
        direction === "buy" ? tokenConfig.pairDecimals : tokenConfig.decimals;
      logger.info(
        `Executing ${direction} swap: ${ethers.formatUnits(amountIn, inDecimals)} ` +
          `${direction === "buy" ? "USDT" : tokenConfig.name} via ${wallet.address} ` +
          `| route=${tokenConfig.route} | impact=${(priceImpactBps / 100).toFixed(2)}%`
      );

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        amountIn,
        amountOutMin,
        path,
        wallet.address,
        deadline,
        { gasLimit: this.config.gasLimitOverride }
      );

      const receipt = await tx.wait();
      // The output amount lands in the recipient via the *final* pair's
      // Swap event — this is true for both single- and multi-hop.
      const finalPair = pairPath[pairPath.length - 1];
      const amountOut = this.parseAmountOut(
        receipt,
        finalPair,
        outputToken,
        wallet.address
      );

      logger.info(
        `Swap confirmed: ${tx.hash} | Gas: ${receipt.gasUsed} | Out: ${amountOut}`
      );

      return {
        success: true,
        txHash: tx.hash,
        amountIn: amountIn.toString(),
        amountOut,
        direction,
        tokenName: tokenConfig.name,
        walletAddress: wallet.address,
        gasUsed: receipt.gasUsed.toString(),
        priceImpactBps,
      };
    } catch (error: any) {
      logger.error(
        `Swap failed (${direction} ${tokenConfig.name} via ${wallet.address}): ${error.message}`
      );
      return {
        success: false,
        txHash: "",
        amountIn: amountIn.toString(),
        amountOut: "0",
        direction,
        tokenName: tokenConfig.name,
        walletAddress: wallet.address,
        gasUsed: "0",
        priceImpactBps: 0,
        error: error.message,
      };
    }
  }

  // ─── Log Parsing ──────────────────────────────────────────────────
  /**
   * Recover the actual output amount from the final pair's Swap event.
   *
   * The event reports four reserves-delta values; for the recipient's
   * leg, exactly one of amount0Out / amount1Out is non-zero. We don't
   * need token0()/token1() to disambiguate — the non-zero one IS the
   * output.
   *
   * For multi-hop swaps the V2 router routes funds through the next
   * pair as the recipient; the LAST pair's `to` field is the user's
   * wallet, so we filter on that.
   */
  private parseAmountOut(
    receipt: ethers.TransactionReceipt,
    pairAddress: string,
    _outputToken: string,
    walletAddress: string
  ): string {
    const pairLower = pairAddress.toLowerCase();
    const recipientLower = walletAddress.toLowerCase();

    for (const log of receipt.logs as Log[]) {
      if (log.address.toLowerCase() !== pairLower) continue;
      if (log.topics[0] !== V2_SWAP_TOPIC) continue;

      try {
        const parsed = v2PairIface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (!parsed) continue;
        const to: string = (parsed.args.to as string).toLowerCase();
        if (to !== recipientLower) continue;

        const amount0Out = parsed.args.amount0Out as bigint;
        const amount1Out = parsed.args.amount1Out as bigint;
        const out = amount0Out > 0n ? amount0Out : amount1Out;
        return out.toString();
      } catch {
        continue;
      }
    }

    logger.warn(
      `Could not parse amountOut from V2 Swap event on pair ${pairAddress} — delta-neutral accounting may drift`
    );
    return "0";
  }

  // ─── Utility ──────────────────────────────────────────────────────
  amountFromUsd(usdAmount: number, decimals: number): bigint {
    return ethers.parseUnits(usdAmount.toFixed(6), decimals);
  }
}
