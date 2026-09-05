import "dotenv/config";
import path from "path";

// ─── Token Definitions ───────────────────────────────────────────────
//
// Unlike the original Token X bot, tokens here are NOT hardcoded. They live
// in a JSON registry on disk (see services/token-registry.ts) which the
// dashboard adds and removes from at runtime. This struct is the
// validated, in-memory shape that the engine and strategies consume.

/**
 * How this token reaches USDT.
 *   - "direct"   → swap path is [token, USDT]; pairAddress = token/USDT pair.
 *   - "wbnb-hop" → swap path is [token, WBNB, USDT]; pairAddress = token/WBNB
 *                  pair, wbnbUsdtPair = the canonical WBNB/USDT pair.
 *
 * Tokens with no liquid V2 pair on either path are rejected at registration.
 */
export type TokenRoute = "direct" | "wbnb-hop";

export interface TokenConfig {
  /** Stable map key — derived from the contract symbol; uppercased. */
  key: string;
  /** Human-readable display name. */
  name: string;
  /** Token contract address (BSC). */
  address: string;
  /** Decimals as reported by the ERC20 contract. */
  decimals: number;
  /** USDT pair token (kept here for symmetry with the original bot). */
  pairToken: string;
  /** USDT decimals on BSC = 18. */
  pairDecimals: number;
  /**
   * Primary V2 pair the bot quotes against:
   *   - direct   route: token/USDT pair address
   *   - wbnb-hop route: token/WBNB pair address
   * Health checks read its reserves to decide whether the token is tradable.
   */
  pairAddress: string;
  /** How this token reaches USDT. Defaults to "direct" for back-compat. */
  route: TokenRoute;
  /**
   * Second-hop pair for wbnb-hop tokens (the WBNB/USDT pair). Required when
   * route === "wbnb-hop"; ignored otherwise.
   */
  wbnbUsdtPair?: string;
  /** Whether the engine should trade this token. */
  enabled: boolean;
  /** Global wallet indices assigned to this token (0-based). */
  walletIndices: number[];
}

// ─── Trading Mode ────────────────────────────────────────────────────
export type TradingMode = "delta_neutral" | "dca_buy" | "dca_sell" | "stopped";

// ─── Price Defense ───────────────────────────────────────────────────

/**
 * Which way round the operator quoted the target price. Tokens priced far
 * below a dollar read more naturally as "tokens per dollar", so both
 * conventions are accepted and normalised internally.
 */
export type TargetPriceUnit = "USD_PER_TOKEN" | "TOKEN_PER_USD";

/** Whether the defense persists past the target or stands down on arrival. */
export type TargetPriceMode = "hold" | "reach";

// ─── Per-Token Trading Parameters ────────────────────────────────────
export interface TradingParams {
  mode: TradingMode;
  tradeAmountUsd: number;
  intervalSeconds: number;
  variancePercent: number;
  dailyVolumeTargetUsd: number;
  /** Slippage tolerance applied to amountOutMin (bps; 100 = 1%). */
  maxSlippageBps: number;
  /**
   * Constant-product price-impact ceiling (bps; 1000 = 10%). The swap is
   * aborted before submission if the on-curve impact exceeds this threshold.
   * Set higher for thin pools, lower for deep ones.
   */
  maxPriceImpactBps: number;
  dcaBiasPercent: number;

  // ─── Natural-trading parameters (delta_neutral only) ──────────────
  /** Lower bound of daily drift target (%, e.g., 1 for 1%). */
  dailyDriftMinPct: number;
  /** Upper bound of daily drift target (%, e.g., 5 for 5%). */
  dailyDriftMaxPct: number;
  /** Strength of pull toward the weekly anchor in daily direction roll. */
  anchorPullStrength: number;
  /** Strength of bias toward today's target in within-day direction selection. */
  biasStrength: number;
  /** Standard deviation (as fraction of base) for gaussian trade sizing. */
  tradeSizeSigma: number;
  /** Per-tick probability of starting a 30–60 min quiet period. */
  quietPeriodProbability: number;

  // ─── Price defense (delta_neutral only) ────────────────────────────
  //
  // An absolute price level the bot pushes toward, independent of where
  // the market currently sits. This is what the weekly-anchor drift alone
  // cannot do: the anchor re-bases to today's open every morning, so a
  // sustained sell-off drags the target down with it. A target price is
  // fixed until the operator moves it, so the bot keeps buying the dip
  // for as long as the dip lasts.
  //
  // 0 disables the defense and restores pure anchor-drift behaviour.

  /** Absolute price to defend. 0 disables the price defense. */
  targetPrice: number;
  /** Quote direction of targetPrice — either convention is accepted. */
  targetPriceUnit: TargetPriceUnit;
  /**
   * Multiplier on log(target / price). 10 means a 1% gap moves P(buy) by
   * roughly 0.1; a 10% gap saturates against the pBuy clamp.
   */
  targetPriceStrength: number;
  /**
   * "hold" keeps defending the level indefinitely. "reach" disengages the
   * skew the first time the price touches or crosses the target, after
   * which the token trades pure delta-neutral.
   */
  targetPriceMode: TargetPriceMode;
  /** Band (%) around the target that counts as having reached it. */
  targetPriceReachedTolerancePct: number;
  /**
   * Applying a target further than this (%) from the live price needs an
   * explicit confirmation. Catches unit mix-ups and fat fingers before
   * they turn into a one-sided buying spree. <= 0 disables the guard.
   */
  targetPriceMaxDeviationPct: number;
  /** Lower clamp on P(buy) — keeps some counter-direction flow alive. */
  pBuyMin: number;
  /** Upper clamp on P(buy). */
  pBuyMax: number;
}

// ─── Main Config ─────────────────────────────────────────────────────
export interface AppConfig {
  rpcUrl: string;
  chainId: number;
  walletKeys: string[];

  // PancakeSwap V2 contracts (BSC mainnet defaults).
  v2RouterAddress: string;
  v2FactoryAddress: string;

  // Stable pair token (USDT on BSC).
  usdtAddress: string;
  // WBNB on BSC — used as the intermediate hop for tokens without a direct
  // USDT pair.
  wbnbAddress: string;

  // Registry persistence.
  tokensFile: string;
  trackerDataDir: string;
  /** Path to the directory holding per-token weekly anchor JSON files. */
  anchorDataDir: string;

  // Defaults applied to newly-registered tokens.
  defaultTradingParams: TradingParams;
  defaultWalletSelector: string; // raw "1-3" / "1,2,5" / "" form

  dashboardPort: number;
  dashboardApiKey: string;
  maxGasPriceGwei: number;
  gasLimitOverride: number;
  /** How often the bot refreshes BNB balances of all wallets (seconds). */
  balanceRefreshIntervalSec: number;
  dryRun: boolean;
}

function requiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function isValidAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

// BSC Mainnet stablecoin
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
// Canonical WBNB on BSC mainnet — used as the intermediate hop when a token
// has no direct USDT pair. Same address PancakeSwap V2 SDK uses.
const BSC_WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

// PancakeSwap V2 canonical contracts (BSC mainnet)
const PANCAKE_V2_ROUTER_DEFAULT = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const PANCAKE_V2_FACTORY_DEFAULT = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";

function parseTargetPriceUnit(v: string): TargetPriceUnit {
  if (v !== "USD_PER_TOKEN" && v !== "TOKEN_PER_USD") {
    throw new Error(
      `Invalid TARGET_PRICE_UNIT '${v}'. Must be USD_PER_TOKEN or TOKEN_PER_USD`
    );
  }
  return v;
}

function parseTargetPriceMode(v: string): TargetPriceMode {
  if (v !== "hold" && v !== "reach") {
    throw new Error(`Invalid TARGET_PRICE_MODE '${v}'. Must be hold or reach`);
  }
  return v;
}

/**
 * Validate the price-defense knobs. Shared by loadConfig (env at boot) and
 * the dashboard's runtime param updates, so a bad value is rejected the
 * same way whichever door it comes through.
 *
 * Throws on the first problem found; returns silently when the params are
 * usable. Fields absent from `p` are not checked — callers may pass a
 * partial patch.
 */
export function validatePriceDefenseParams(p: Partial<TradingParams>): void {
  if (p.targetPrice !== undefined) {
    if (!Number.isFinite(p.targetPrice) || p.targetPrice < 0) {
      throw new Error("targetPrice must be a number >= 0 (0 disables)");
    }
  }
  if (p.targetPriceStrength !== undefined) {
    if (!Number.isFinite(p.targetPriceStrength) || p.targetPriceStrength < 0) {
      throw new Error("targetPriceStrength must be a number >= 0");
    }
  }
  if (p.targetPriceReachedTolerancePct !== undefined) {
    if (
      !Number.isFinite(p.targetPriceReachedTolerancePct) ||
      p.targetPriceReachedTolerancePct < 0
    ) {
      throw new Error("targetPriceReachedTolerancePct must be a number >= 0");
    }
  }
  // pBuy bounds are validated as a pair whenever either side is present, so
  // a patch that only moves one of them still cannot invert the range.
  if (p.pBuyMin !== undefined || p.pBuyMax !== undefined) {
    const lo = p.pBuyMin ?? 0;
    const hi = p.pBuyMax ?? 1;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error("pBuyMin/pBuyMax must be numbers");
    }
    if (lo < 0 || hi > 1 || lo >= hi) {
      throw new Error("pBuyMin/pBuyMax must satisfy 0 <= pBuyMin < pBuyMax <= 1");
    }
  }
}

export function loadConfig(): AppConfig {
  const walletKeysRaw = requiredEnv("WALLET_PRIVATE_KEYS");
  const walletKeys = walletKeysRaw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (walletKeys.length === 0) {
    throw new Error("At least one wallet private key is required");
  }

  const v2RouterAddress = optionalEnv(
    "PANCAKE_V2_ROUTER",
    PANCAKE_V2_ROUTER_DEFAULT
  );
  const v2FactoryAddress = optionalEnv(
    "PANCAKE_V2_FACTORY",
    PANCAKE_V2_FACTORY_DEFAULT
  );
  if (!isValidAddress(v2RouterAddress)) {
    throw new Error(`PANCAKE_V2_ROUTER malformed: ${v2RouterAddress}`);
  }
  if (!isValidAddress(v2FactoryAddress)) {
    throw new Error(`PANCAKE_V2_FACTORY malformed: ${v2FactoryAddress}`);
  }

  const tokensFile =
    optionalEnv("TOKENS_FILE", path.join(process.cwd(), "data", "tokens.json"));

  const trackerDataDir =
    optionalEnv("TRACKER_DATA_DIR", path.join(process.cwd(), "data", "tracker"));

  const anchorDataDir =
    optionalEnv("ANCHOR_DATA_DIR", path.join(process.cwd(), "data", "anchor"));

  const config: AppConfig = {
    rpcUrl: optionalEnv("BSC_RPC_URL", "https://bsc-dataseed1.binance.org"),
    chainId: parseInt(optionalEnv("CHAIN_ID", "56")),
    walletKeys,
    v2RouterAddress,
    v2FactoryAddress,
    usdtAddress: BSC_USDT,
    wbnbAddress: BSC_WBNB,
    tokensFile,
    trackerDataDir,
    anchorDataDir,
    defaultTradingParams: {
      mode: (() => {
        const m = optionalEnv("DEFAULT_MODE", "stopped");
        const valid: TradingMode[] = [
          "delta_neutral",
          "dca_buy",
          "dca_sell",
          "stopped",
        ];
        if (!valid.includes(m as TradingMode)) {
          throw new Error(
            `Invalid DEFAULT_MODE '${m}'. Must be one of: ${valid.join(", ")}`
          );
        }
        return m as TradingMode;
      })(),
      tradeAmountUsd: parseFloat(optionalEnv("TRADE_AMOUNT_USD", "50")),
      intervalSeconds: parseInt(optionalEnv("TRADE_INTERVAL_SECONDS", "300")),
      variancePercent: parseFloat(optionalEnv("VARIANCE_PERCENT", "20")),
      dailyVolumeTargetUsd: parseFloat(
        optionalEnv("DAILY_VOLUME_TARGET_USD", "10000")
      ),
      maxSlippageBps: parseInt(optionalEnv("MAX_SLIPPAGE_BPS", "100")),
      maxPriceImpactBps: parseInt(optionalEnv("MAX_PRICE_IMPACT_BPS", "1000")),
      dcaBiasPercent: parseFloat(optionalEnv("DCA_BIAS_PERCENT", "70")),
      dailyDriftMinPct: parseFloat(optionalEnv("DAILY_DRIFT_MIN_PCT", "1")),
      dailyDriftMaxPct: parseFloat(optionalEnv("DAILY_DRIFT_MAX_PCT", "5")),
      anchorPullStrength: parseFloat(optionalEnv("ANCHOR_PULL_STRENGTH", "3")),
      biasStrength: parseFloat(optionalEnv("BIAS_STRENGTH", "5")),
      tradeSizeSigma: parseFloat(optionalEnv("TRADE_SIZE_SIGMA", "0.4")),
      quietPeriodProbability: parseFloat(
        optionalEnv("QUIET_PERIOD_PROBABILITY", "0.005")
      ),
      targetPrice: parseFloat(optionalEnv("TARGET_PRICE", "0")),
      targetPriceUnit: parseTargetPriceUnit(
        optionalEnv("TARGET_PRICE_UNIT", "USD_PER_TOKEN")
      ),
      targetPriceStrength: parseFloat(
        optionalEnv("TARGET_PRICE_STRENGTH", "10")
      ),
      targetPriceMode: parseTargetPriceMode(
        optionalEnv("TARGET_PRICE_MODE", "hold")
      ),
      targetPriceReachedTolerancePct: parseFloat(
        optionalEnv("TARGET_PRICE_REACHED_TOLERANCE_PCT", "1")
      ),
      targetPriceMaxDeviationPct: parseFloat(
        optionalEnv("TARGET_PRICE_MAX_DEVIATION_PCT", "10")
      ),
      pBuyMin: parseFloat(optionalEnv("BUY_PROB_MIN", "0.15")),
      pBuyMax: parseFloat(optionalEnv("BUY_PROB_MAX", "0.85")),
    },
    defaultWalletSelector: optionalEnv("DEFAULT_TOKEN_WALLETS", ""),
    dashboardPort: parseInt(optionalEnv("PORT", "3000")),
    dashboardApiKey: optionalEnv("DASHBOARD_API_KEY", "changeme"),
    maxGasPriceGwei: parseFloat(optionalEnv("MAX_GAS_PRICE_GWEI", "5")),
    gasLimitOverride: parseInt(optionalEnv("GAS_LIMIT_OVERRIDE", "500000")),
    balanceRefreshIntervalSec: parseInt(
      optionalEnv("BALANCE_REFRESH_INTERVAL_SECONDS", "120")
    ),
    dryRun: optionalEnv("DRY_RUN", "false") === "true",
  };

  validatePriceDefenseParams(config.defaultTradingParams);

  return config;
}

/**
 * Parse a wallet selector string into 0-based indices.
 *
 * Forms:
 *   - "1-3"   → [0, 1, 2]
 *   - "1,3,5" → [0, 2, 4]
 *   - ""      → all wallets
 */
export function parseWalletSelector(
  raw: string,
  totalWallets: number
): number[] {
  const v = raw.trim();
  if (!v) return Array.from({ length: totalWallets }, (_, i) => i);

  if (v.includes("-") && !v.includes(",")) {
    const [startStr, endStr] = v.split("-");
    const start = parseInt(startStr) - 1;
    const end = parseInt(endStr) - 1;
    const indices: number[] = [];
    for (let i = start; i <= end && i < totalWallets; i++) {
      if (i >= 0) indices.push(i);
    }
    return indices;
  }

  return v
    .split(",")
    .map((s) => parseInt(s.trim()) - 1)
    .filter((i) => i >= 0 && i < totalWallets);
}
