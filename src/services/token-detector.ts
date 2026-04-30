import { Contract, JsonRpcProvider, ethers } from "ethers";
import { AppConfig, TokenRoute } from "../config";
import { TokenValidationError } from "./errors";
import { logger } from "../utils/logger";

const ERC20_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address)",
];

const V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface TokenDetectionResult {
  /** Stable map key — derived from symbol; uppercased. */
  key: string;
  /** Human-readable display name (from name()). */
  name: string;
  /** Token symbol (used to derive the key). */
  symbol: string;
  /** Token contract address (canonicalized to checksum). */
  address: string;
  /** Decimals from ERC20 decimals(). */
  decimals: number;
  /**
   * How this token reaches USDT. "direct" if a token/USDT pair exists,
   * "wbnb-hop" if only a token/WBNB pair exists (and WBNB/USDT exists).
   */
  route: TokenRoute;
  /** Primary pair address (token/USDT for direct, token/WBNB for wbnb-hop). */
  pairAddress: string;
  /** Second-hop pair (WBNB/USDT) — present only for wbnb-hop. */
  wbnbUsdtPair?: string;
  /**
   * Reserves on the primary pair, formatted as raw bigint strings. Token
   * side and pair side are split out for the dashboard display; for
   * wbnb-hop the "usdt" field is actually the WBNB-side reserve.
   */
  reserves: {
    token: string;
    pair: string;
  };
  /**
   * For wbnb-hop tokens, an estimate of the USD price derived from chained
   * pair quotes (token→WBNB→USDT). Empty string if unavailable.
   */
  estimatedPriceUsd?: string;
}

/**
 * Auto-discovery for new tokens. Given a contract address, this:
 *
 *   1. Validates the address syntax.
 *   2. Reads ERC20 metadata (name, symbol, decimals).
 *   3. Asks the V2 factory for a (token, USDT) pair. If found and
 *      initialized, route = "direct".
 *   4. Else asks for a (token, WBNB) pair AND verifies the canonical
 *      (WBNB, USDT) pair exists. If both check out, route = "wbnb-hop".
 *   5. Else rejects — there's no path to USDT on V2.
 *
 * Why prefer direct over wbnb-hop when both exist? Two hops means two
 * 0.25% fees and two slippage events; for thin pools that quickly adds
 * up. Direct is cheaper and safer.
 */
export class TokenDetector {
  private provider: JsonRpcProvider;
  private factoryAddress: string;
  private usdtAddress: string;
  private wbnbAddress: string;

  constructor(config: AppConfig, provider: JsonRpcProvider) {
    this.provider = provider;
    this.factoryAddress = config.v2FactoryAddress;
    this.usdtAddress = config.usdtAddress;
    this.wbnbAddress = config.wbnbAddress;
  }

  /**
   * Run full detection on an address. Throws TokenValidationError with a
   * human-readable message on any failure mode.
   */
  async detect(rawAddress: string): Promise<TokenDetectionResult> {
    const address = this.normalizeAddress(rawAddress);

    if (address.toLowerCase() === this.usdtAddress.toLowerCase()) {
      throw new TokenValidationError(
        "Cannot register USDT itself — USDT is the pair token."
      );
    }
    if (address.toLowerCase() === this.wbnbAddress.toLowerCase()) {
      throw new TokenValidationError(
        "Cannot register WBNB itself — it's used only as a hop token."
      );
    }

    const erc20 = new Contract(address, ERC20_ABI, this.provider);

    let name: string;
    let symbol: string;
    let decimals: number;
    try {
      [name, symbol, decimals] = await Promise.all([
        erc20.name() as Promise<string>,
        erc20.symbol() as Promise<string>,
        erc20
          .decimals()
          .then((v: bigint | number) => Number(v)) as Promise<number>,
      ]);
    } catch (err: any) {
      logger.warn(`[Detector] ERC20 read failed for ${address}: ${err.message}`);
      throw new TokenValidationError(
        `Address ${address} does not look like a standard ERC20 (name/symbol/decimals reverted).`
      );
    }

    if (!symbol) {
      throw new TokenValidationError(
        `ERC20 at ${address} returned an empty symbol.`
      );
    }
    if (decimals < 0 || decimals > 36 || !Number.isFinite(decimals)) {
      throw new TokenValidationError(
        `ERC20 at ${address} returned an invalid decimals value (${decimals}).`
      );
    }

    const factory = new Contract(
      this.factoryAddress,
      V2_FACTORY_ABI,
      this.provider
    );

    // Try direct (token/USDT) first.
    const direct = await this.lookupPair(factory, address, this.usdtAddress);
    if (direct) {
      const reserves = await this.readReserves(direct, address, this.usdtAddress);
      return {
        key: symbol.toUpperCase(),
        name,
        symbol,
        address,
        decimals,
        route: "direct",
        pairAddress: direct,
        reserves: {
          token: reserves.tokenSide.toString(),
          pair: reserves.pairSide.toString(),
        },
      };
    }

    // Fall back to WBNB hop. We need BOTH the token/WBNB pair AND the
    // canonical WBNB/USDT pair — the latter must exist or we have no way
    // to price the trade in USDT.
    const tokenWbnb = await this.lookupPair(factory, address, this.wbnbAddress);
    if (!tokenWbnb) {
      throw new TokenValidationError(
        `No PancakeSwap V2 pair exists for ${symbol} against either USDT or WBNB. Create the pair on-chain before registering.`
      );
    }
    const wbnbUsdt = await this.lookupPair(
      factory,
      this.wbnbAddress,
      this.usdtAddress
    );
    if (!wbnbUsdt) {
      throw new TokenValidationError(
        `Found ${symbol}/WBNB pair but no WBNB/USDT pair on this factory — cannot price in USDT.`
      );
    }

    const reservesA = await this.readReserves(
      tokenWbnb,
      address,
      this.wbnbAddress
    );
    const reservesB = await this.readReserves(
      wbnbUsdt,
      this.wbnbAddress,
      this.usdtAddress
    );

    // Estimate USD price = (WBNB per token) * (USDT per WBNB).
    const estimatedPriceUsd = this.estimateHopPrice(
      reservesA.tokenSide,
      reservesA.pairSide, // WBNB-side reserves
      reservesB.tokenSide, // WBNB-side reserves of WBNB/USDT pair
      reservesB.pairSide, // USDT-side
      decimals
    );

    return {
      key: symbol.toUpperCase(),
      name,
      symbol,
      address,
      decimals,
      route: "wbnb-hop",
      pairAddress: tokenWbnb,
      wbnbUsdtPair: wbnbUsdt,
      reserves: {
        token: reservesA.tokenSide.toString(),
        pair: reservesA.pairSide.toString(),
      },
      estimatedPriceUsd: estimatedPriceUsd || undefined,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Look up a V2 pair. Returns the pair address if it exists and is
   * non-zero; null if no pair has been deployed.
   */
  private async lookupPair(
    factory: Contract,
    a: string,
    b: string
  ): Promise<string | null> {
    let pair: string;
    try {
      pair = await factory.getPair(a, b);
    } catch (err: any) {
      throw new TokenValidationError(`V2 factory call failed: ${err.message}`);
    }
    if (!pair || pair.toLowerCase() === ZERO_ADDRESS) return null;
    return pair;
  }

  /**
   * Read reserves on a pair, returning them in token/pair-side terms
   * (not raw token0/token1 — caller specifies which side they care
   * about).
   */
  private async readReserves(
    pairAddress: string,
    tokenSideAddress: string,
    pairSideAddress: string
  ): Promise<{ tokenSide: bigint; pairSide: bigint }> {
    try {
      const pair = new Contract(pairAddress, V2_PAIR_ABI, this.provider);
      const [reserve0, reserve1] = await pair.getReserves();
      const token0: string = await pair.token0();
      const tokenIsToken0 =
        token0.toLowerCase() === tokenSideAddress.toLowerCase();
      return {
        tokenSide: tokenIsToken0 ? BigInt(reserve0) : BigInt(reserve1),
        pairSide: tokenIsToken0 ? BigInt(reserve1) : BigInt(reserve0),
      };
    } catch (err: any) {
      logger.warn(
        `[Detector] Pair reserves read failed for ${pairAddress}: ${err.message}`
      );
      return { tokenSide: 0n, pairSide: 0n };
    }
  }

  /**
   * Compute an approximate USD spot price for a wbnb-hop token using
   * fixed-point bigint math. This is just for UI display at registration
   * time — the swap path uses live router quotes.
   */
  private estimateHopPrice(
    reserveTokenInTokenWbnb: bigint,
    reserveWbnbInTokenWbnb: bigint,
    reserveWbnbInWbnbUsdt: bigint,
    reserveUsdtInWbnbUsdt: bigint,
    tokenDecimals: number
  ): string {
    if (
      reserveTokenInTokenWbnb === 0n ||
      reserveWbnbInTokenWbnb === 0n ||
      reserveWbnbInWbnbUsdt === 0n ||
      reserveUsdtInWbnbUsdt === 0n
    ) {
      return "";
    }
    // tokenPriceInWbnb = reserveWbnb / reserveToken (decimals adjusted)
    // wbnbPriceInUsdt  = reserveUsdt / reserveWbnb (both 18-dec, cancels)
    // priceUsd        = tokenPriceInWbnb * wbnbPriceInUsdt
    const PRECISION = 10n ** 18n;
    // WBNB and USDT both have 18 decimals on BSC — the only adjustment is
    // for tokenDecimals.
    let priceTokenInWbnb =
      (reserveWbnbInTokenWbnb * PRECISION) / reserveTokenInTokenWbnb;
    const decAdj = tokenDecimals - 18;
    if (decAdj > 0) {
      priceTokenInWbnb *= 10n ** BigInt(decAdj);
    } else if (decAdj < 0) {
      priceTokenInWbnb /= 10n ** BigInt(-decAdj);
    }
    const wbnbInUsdt =
      (reserveUsdtInWbnbUsdt * PRECISION) / reserveWbnbInWbnbUsdt;
    const priceUsd = (priceTokenInWbnb * wbnbInUsdt) / PRECISION;
    return (Number(priceUsd) / Number(PRECISION)).toString();
  }

  private normalizeAddress(raw: string): string {
    const trimmed = (raw ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      throw new TokenValidationError(
        `"${raw}" is not a valid 0x-prefixed 40-hex-char address.`
      );
    }
    try {
      return ethers.getAddress(trimmed);
    } catch (err: any) {
      throw new TokenValidationError(
        `Address ${trimmed} failed checksum: ${err.message}`
      );
    }
  }
}
