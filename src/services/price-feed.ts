import { Contract, JsonRpcProvider, ethers } from "ethers";
import { TokenConfig, AppConfig } from "../config";
import { PriceUnavailableError } from "./errors";
import { logger } from "../utils/logger";

const V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
];

export interface PriceData {
  tokenName: string;
  tokenAddress: string;
  priceUsd: number;
  /** Pair total liquidity (USDT-side reserves), as a raw bigint string. */
  liquidity: string;
  timestamp: number;
}

/**
 * Spot price reader for PancakeSwap V2 pairs.
 *
 * For direct route the price formula is:
 *   priceUsd = reserveUsdt * 10^(tokenDecimals - pairDecimals) / reserveToken
 *
 * For wbnb-hop the price is computed as the product of two pair quotes:
 *   priceUsd(token) = price(token in WBNB) * price(WBNB in USDT)
 *
 * We compute in fixed-point bigint then convert to a JS number.
 */
export class PriceFeed {
  private config: AppConfig;
  private provider: JsonRpcProvider;
  private priceCache: Map<string, PriceData> = new Map();
  /** token0() result is immutable per pair — cache forever. */
  private token0Cache: Map<string, string> = new Map();

  constructor(config: AppConfig, provider: JsonRpcProvider) {
    this.config = config;
    this.provider = provider;
  }

  private async getToken0(pairAddress: string): Promise<string> {
    const key = pairAddress.toLowerCase();
    const cached = this.token0Cache.get(key);
    if (cached) return cached;
    const pair = new Contract(pairAddress, V2_PAIR_ABI, this.provider);
    const t0 = (await pair.token0()) as string;
    this.token0Cache.set(key, t0.toLowerCase());
    return t0.toLowerCase();
  }

  /**
   * Read reserves on a pair and return them split by which side is
   * `wantedSideAddress` (the "in"/"token" side) vs the other side.
   */
  private async readReservesBySide(
    pairAddress: string,
    wantedSideAddress: string
  ): Promise<{ wanted: bigint; other: bigint }> {
    const pair = new Contract(pairAddress, V2_PAIR_ABI, this.provider);
    const [r0, r1] = await pair.getReserves();
    const token0 = await this.getToken0(pairAddress);
    const wantedIsToken0 = wantedSideAddress.toLowerCase() === token0;
    return {
      wanted: BigInt(wantedIsToken0 ? r0 : r1),
      other: BigInt(wantedIsToken0 ? r1 : r0),
    };
  }

  async getPrice(tokenConfig: TokenConfig): Promise<PriceData> {
    try {
      let priceUsd = 0;
      let liquidityUsdt = 0n;

      if (tokenConfig.route === "direct") {
        const { wanted: reserveToken, other: reserveUsdt } =
          await this.readReservesBySide(
            tokenConfig.pairAddress,
            tokenConfig.address
          );

        if (reserveToken > 0n && reserveUsdt > 0n) {
          priceUsd = this.computeDirectPriceUsd(
            reserveToken,
            reserveUsdt,
            tokenConfig.decimals,
            tokenConfig.pairDecimals
          );
          liquidityUsdt = reserveUsdt;
        }
      } else {
        // wbnb-hop: price = (WBNB per token) * (USDT per WBNB)
        if (!tokenConfig.wbnbUsdtPair) {
          throw new Error(
            `Token ${tokenConfig.key} is wbnb-hop but missing wbnbUsdtPair`
          );
        }
        const tokenWbnb = await this.readReservesBySide(
          tokenConfig.pairAddress,
          tokenConfig.address
        );
        const wbnbUsdt = await this.readReservesBySide(
          tokenConfig.wbnbUsdtPair,
          this.config.wbnbAddress
        );

        const reserveToken = tokenWbnb.wanted;
        const reserveWbnbA = tokenWbnb.other;
        const reserveWbnbB = wbnbUsdt.wanted;
        const reserveUsdt = wbnbUsdt.other;

        if (
          reserveToken > 0n &&
          reserveWbnbA > 0n &&
          reserveWbnbB > 0n &&
          reserveUsdt > 0n
        ) {
          priceUsd = this.computeHopPriceUsd(
            reserveToken,
            reserveWbnbA,
            reserveWbnbB,
            reserveUsdt,
            tokenConfig.decimals
          );
          // Liquidity proxy for hop tokens: the WBNB-side reserve of the
          // token's pair, converted to USDT.
          // This is the LP depth that *bounds* trade size on the first hop.
          if (reserveWbnbB > 0n) {
            liquidityUsdt = (reserveWbnbA * reserveUsdt) / reserveWbnbB;
          }
        }
      }

      const data: PriceData = {
        tokenName: tokenConfig.name,
        tokenAddress: tokenConfig.address,
        priceUsd,
        liquidity: liquidityUsdt.toString(),
        timestamp: Date.now(),
      };

      this.priceCache.set(tokenConfig.address, data);
      return data;
    } catch (error: any) {
      logger.warn(
        `Failed to fetch price for ${tokenConfig.name}: ${error.message}`
      );
      const cached = this.priceCache.get(tokenConfig.address);
      if (cached) return cached;
      return {
        tokenName: tokenConfig.name,
        tokenAddress: tokenConfig.address,
        priceUsd: 0,
        liquidity: "0",
        timestamp: Date.now(),
      };
    }
  }

  /** Direct pair: priceUsd = reservePair * 10^(tokenDecimals-pairDecimals) / reserveToken */
  private computeDirectPriceUsd(
    reserveToken: bigint,
    reservePair: bigint,
    tokenDecimals: number,
    pairDecimals: number
  ): number {
    const PRECISION = 10n ** 18n;
    const decAdj = tokenDecimals - pairDecimals;
    let numerator = reservePair * PRECISION;
    if (decAdj > 0) numerator *= 10n ** BigInt(decAdj);
    else if (decAdj < 0) numerator /= 10n ** BigInt(-decAdj);
    const priceScaled = numerator / reserveToken;
    return Number(priceScaled) / Number(PRECISION);
  }

  /** Hop pair: chain (token→WBNB) and (WBNB→USDT) prices. */
  private computeHopPriceUsd(
    reserveTokenInTokenWbnb: bigint,
    reserveWbnbInTokenWbnb: bigint,
    reserveWbnbInWbnbUsdt: bigint,
    reserveUsdtInWbnbUsdt: bigint,
    tokenDecimals: number
  ): number {
    const PRECISION = 10n ** 18n;
    // tokenInWbnb = WBNB-reserve / token-reserve (decimals adjustment for token)
    // WBNB has 18 decimals.
    let priceTokenInWbnb =
      (reserveWbnbInTokenWbnb * PRECISION) / reserveTokenInTokenWbnb;
    const decAdj = tokenDecimals - 18;
    if (decAdj > 0) priceTokenInWbnb *= 10n ** BigInt(decAdj);
    else if (decAdj < 0) priceTokenInWbnb /= 10n ** BigInt(-decAdj);

    // wbnbInUsdt — both 18 decimals so no extra adjustment.
    const wbnbInUsdt =
      (reserveUsdtInWbnbUsdt * PRECISION) / reserveWbnbInWbnbUsdt;
    const priceUsdScaled = (priceTokenInWbnb * wbnbInUsdt) / PRECISION;
    return Number(priceUsdScaled) / Number(PRECISION);
  }

  getAllPrices(): PriceData[] {
    return Array.from(this.priceCache.values());
  }

  /**
   * Convert a USD sell amount to token units using the live price.
   * Throws PriceUnavailableError if the price is zero/negative so callers
   * can skip the trade rather than send a wrong-decimals amount.
   */
  async usdToTokenAmount(
    usdAmount: number,
    tokenConfig: TokenConfig
  ): Promise<bigint> {
    const price = await this.getPrice(tokenConfig);
    if (price.priceUsd <= 0) {
      throw new PriceUnavailableError(tokenConfig.name);
    }
    const tokenAmount = usdAmount / price.priceUsd;
    return ethers.parseUnits(
      tokenAmount.toFixed(Math.min(tokenConfig.decimals, 8)),
      tokenConfig.decimals
    );
  }

  /** Drop a token's cached price (called on registry remove). */
  clearCache(tokenAddress: string): void {
    this.priceCache.delete(tokenAddress);
  }
}
