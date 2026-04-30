import { Contract, JsonRpcProvider } from "ethers";
import { TokenConfig } from "../config";

const V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

export interface HealthResult {
  available: boolean;
  error?: string;
}

/**
 * Probe a token's V2 pair(s) at startup. Tokens whose pairs have zero
 * liquidity are marked unavailable; their trade loops never start.
 *
 * For wbnb-hop tokens we check BOTH pairs — token/WBNB AND WBNB/USDT —
 * since either being empty makes the token un-priceable in USD.
 */
export async function checkTokenHealth(
  token: TokenConfig,
  provider: JsonRpcProvider
): Promise<HealthResult> {
  try {
    const primary = new Contract(token.pairAddress, V2_PAIR_ABI, provider);
    const [r0, r1] = await primary.getReserves();
    if (BigInt(r0) === 0n || BigInt(r1) === 0n) {
      return { available: false, error: "Primary pair has zero liquidity" };
    }

    if (token.route === "wbnb-hop") {
      if (!token.wbnbUsdtPair) {
        return {
          available: false,
          error: "wbnb-hop token missing wbnbUsdtPair in registry",
        };
      }
      const secondary = new Contract(
        token.wbnbUsdtPair,
        V2_PAIR_ABI,
        provider
      );
      const [s0, s1] = await secondary.getReserves();
      if (BigInt(s0) === 0n || BigInt(s1) === 0n) {
        return {
          available: false,
          error: "WBNB/USDT pair has zero liquidity",
        };
      }
    }

    return { available: true };
  } catch (e: any) {
    return { available: false, error: `On-chain check failed: ${e.message}` };
  }
}
