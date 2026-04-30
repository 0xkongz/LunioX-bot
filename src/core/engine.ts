import { JsonRpcProvider } from "ethers";
import {
  AppConfig,
  TokenConfig,
  TradingMode,
  TradingParams,
  parseWalletSelector,
} from "../config";
import { WalletManager } from "./wallet-manager";
import { DailyTracker } from "./tracker";
import { SwapService } from "../services/swap";
import { PriceFeed, PriceData } from "../services/price-feed";
import { PriceUnavailableError, TokenValidationError } from "../services/errors";
import { TokenRegistry } from "../services/token-registry";
import { TokenDetector } from "../services/token-detector";
import { checkTokenHealth } from "./health";
import { BaseStrategy, TradeDecision } from "../strategies/base";
import { DeltaNeutralStrategy } from "../strategies/delta-neutral";
import { DCABuyStrategy } from "../strategies/dca-buy";
import { DCASellStrategy } from "../strategies/dca-sell";
import { randomize } from "../utils/random";
import { logger } from "../utils/logger";

export interface TokenState {
  tokenName: string;
  tokenKey: string;
  tokenAddress: string;
  pairAddress: string;
  /** "direct" or "wbnb-hop" — surfaced to the dashboard so operators
   * see at a glance which path each token is using. */
  route: "direct" | "wbnb-hop";
  /** Second-hop pair for wbnb-hop tokens; empty string otherwise. */
  wbnbUsdtPair: string;
  enabled: boolean;
  mode: TradingMode;
  params: TradingParams;
  running: boolean;
  available: boolean;
  healthError?: string;
  lastTradeTime: number;
  nextTradeTime: number;
  walletIndices: number[];
  error?: string;
}

export interface EngineStatus {
  running: boolean;
  uptime: number;
  tokens: TokenState[];
  wallets: ReturnType<WalletManager["getSummary"]>;
  dailySummary: ReturnType<DailyTracker["getDashboardSummary"]>;
  recentTrades: ReturnType<DailyTracker["getRecentTrades"]>;
  prices: PriceData[];
}

/**
 * Trading engine for the LunioX bot.
 *
 * Differences from the original Token X engine:
 *   - Tokens are not loaded from a hardcoded literal — they come from the
 *     TokenRegistry (JSON file on a Railway volume).
 *   - Tokens can be added, updated, or removed at runtime; the engine
 *     reacts by spinning up / tearing down per-token state without a
 *     full process restart.
 *   - Health probe and price reads target PancakeSwap V2 pairs instead
 *     of V4 Infinity CL pools.
 */
export class TradingEngine {
  private config: AppConfig;
  private provider: JsonRpcProvider;
  private walletManager: WalletManager;
  private tracker: DailyTracker;
  private swapService: SwapService;
  private priceFeed: PriceFeed;
  private registry: TokenRegistry;
  private detector: TokenDetector;

  // Per-token strategy and state
  private strategies: Map<string, BaseStrategy> = new Map();
  private tokenStates: Map<string, TokenState> = new Map();
  private tokenTimers: Map<string, NodeJS.Timeout> = new Map();

  private running = false;
  private startTime = 0;
  private balanceRefreshTimer: NodeJS.Timeout | null = null;
  private rebalanceTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
    this.walletManager = new WalletManager(config.walletKeys, this.provider);
    this.tracker = new DailyTracker(config.trackerDataDir);

    this.swapService = new SwapService(config, this.provider);
    this.priceFeed = new PriceFeed(config, this.provider);

    this.registry = new TokenRegistry(config.tokensFile);
    this.detector = new TokenDetector(config, this.provider);

    // Bootstrap state for every token already in the registry.
    for (const token of this.registry.list()) {
      this.bootstrapTokenState(token);
    }

    // Refresh BNB balances regularly (independent of trading).
    this.walletManager.refreshBalances().catch((err) => {
      logger.error(`Initial balance refresh failed: ${err.message ?? err}`);
    });
    this.balanceRefreshTimer = setInterval(() => {
      this.walletManager.refreshBalances().catch((err) => {
        logger.error(`Balance refresh failed: ${err.message ?? err}`);
      });
    }, 10 * 60 * 1000);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Build the per-token state and strategy. Pure book-keeping; does not
   * start the trading loop. Called both at boot (for each registered
   * token) and at runtime when a new token is added.
   */
  private bootstrapTokenState(token: TokenConfig): void {
    if (!token.enabled) {
      // We still maintain a state entry for disabled tokens so the
      // dashboard can show them and toggle them on without losing
      // history. We just don't create a strategy or wallet group.
      this.tokenStates.set(token.key, {
        tokenName: token.name,
        tokenKey: token.key,
        tokenAddress: token.address,
        pairAddress: token.pairAddress,
        route: token.route,
        wbnbUsdtPair: token.wbnbUsdtPair ?? "",
        enabled: false,
        mode: "stopped",
        params: { ...this.config.defaultTradingParams, mode: "stopped" },
        running: false,
        available: false,
        lastTradeTime: 0,
        nextTradeTime: 0,
        walletIndices: token.walletIndices,
      });
      return;
    }

    this.walletManager.createTokenGroup(token.key, token.walletIndices);
    const params: TradingParams = { ...this.config.defaultTradingParams };

    this.tokenStates.set(token.key, {
      tokenName: token.name,
      tokenKey: token.key,
      tokenAddress: token.address,
      pairAddress: token.pairAddress,
      route: token.route,
      wbnbUsdtPair: token.wbnbUsdtPair ?? "",
      enabled: true,
      mode: params.mode,
      params,
      running: false,
      available: true, // Optimistic; start() / health probe overrides.
      lastTradeTime: 0,
      nextTradeTime: 0,
      walletIndices: token.walletIndices,
    });

    this.createStrategy(token.key, token, params);
  }

  private createStrategy(
    key: string,
    token: TokenConfig,
    params: TradingParams
  ): void {
    const walletGroup = this.walletManager.getTokenGroup(key);
    let strategy: BaseStrategy;

    switch (params.mode) {
      case "delta_neutral":
        strategy = new DeltaNeutralStrategy(
          token, params, walletGroup,
          this.tracker, this.swapService, this.priceFeed
        );
        break;
      case "dca_buy":
        strategy = new DCABuyStrategy(
          token, params, walletGroup,
          this.tracker, this.swapService, this.priceFeed
        );
        break;
      case "dca_sell":
        strategy = new DCASellStrategy(
          token, params, walletGroup,
          this.tracker, this.swapService, this.priceFeed
        );
        break;
      default:
        strategy = new DeltaNeutralStrategy(
          token, params, walletGroup,
          this.tracker, this.swapService, this.priceFeed
        );
    }
    this.strategies.set(key, strategy);
  }

  /**
   * Start the trading engine: probe every enabled token's pair, then
   * start a per-token loop for any that are healthy and not in
   * "stopped" mode. Idempotent — if already running, no-op.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    logger.info("=== Trading Engine Starting ===");

    for (const token of this.registry.list()) {
      if (!token.enabled) continue;
      const group = this.walletManager.getTokenGroup(token.key);
      logger.info(
        `[${token.name}] Using ${group.count()} wallets: indices ${token.walletIndices.map((i) => i + 1).join(", ")}`
      );
    }

    // ── Startup health check ───────────────────────────────────────
    for (const token of this.registry.list()) {
      if (!token.enabled) continue;
      const state = this.tokenStates.get(token.key);
      if (!state) continue;

      const health = await checkTokenHealth(token, this.provider);
      state.available = health.available;
      state.healthError = health.error;
      if (!health.available) {
        logger.warn(`[${token.name}] Unavailable: ${health.error}`);
      } else {
        logger.info(`[${token.name}] Pair healthy`);
      }
    }

    // ── Initial prices for available tokens ────────────────────────
    for (const token of this.registry.list()) {
      if (!token.enabled) continue;
      const state = this.tokenStates.get(token.key);
      if (!state?.available) continue;
      try {
        await this.priceFeed.getPrice(token);
      } catch (e: any) {
        logger.warn(`Could not fetch initial price for ${token.name}: ${e.message}`);
      }
    }

    // ── Start loops for available + non-stopped tokens ─────────────
    for (const [key, state] of this.tokenStates) {
      if (!state.enabled || !state.available) continue;
      if (state.mode !== "stopped") {
        this.startTokenLoop(key);
      }
    }

    this.rebalanceTimer = setInterval(
      () => this.checkRebalances(),
      60 * 60 * 1000
    );

    logger.info("=== Trading Engine Running ===");
  }

  stop(): void {
    this.running = false;
    for (const [, timer] of this.tokenTimers) {
      clearTimeout(timer);
    }
    this.tokenTimers.clear();
    if (this.rebalanceTimer) clearInterval(this.rebalanceTimer);
    if (this.balanceRefreshTimer) clearInterval(this.balanceRefreshTimer);
    this.balanceRefreshTimer = null;
    this.tracker.flush();
    logger.info("=== Trading Engine Stopped ===");
  }

  // ─── Trading Loops ──────────────────────────────────────────────────

  private startTokenLoop(tokenKey: string): void {
    const state = this.tokenStates.get(tokenKey);
    if (!state || state.mode === "stopped" || !state.available || !state.enabled) return;
    state.running = true;

    const scheduleNext = () => {
      if (!this.running || state.mode === "stopped") {
        state.running = false;
        return;
      }

      const intervalMs =
        randomize(state.params.intervalSeconds, state.params.variancePercent) *
        1000;
      state.nextTradeTime = Date.now() + intervalMs;

      const timer = setTimeout(async () => {
        await this.executeTrade(tokenKey);
        scheduleNext();
      }, intervalMs);

      this.tokenTimers.set(tokenKey, timer);
    };

    this.executeTrade(tokenKey).then(() => scheduleNext());
  }

  private stopTokenLoop(tokenKey: string): void {
    const timer = this.tokenTimers.get(tokenKey);
    if (timer) clearTimeout(timer);
    this.tokenTimers.delete(tokenKey);
    const state = this.tokenStates.get(tokenKey);
    if (state) state.running = false;
  }

  private async executeTrade(tokenKey: string): Promise<void> {
    const state = this.tokenStates.get(tokenKey);
    const strategy = this.strategies.get(tokenKey);
    if (!state || !strategy || state.mode === "stopped") return;

    try {
      const decision: TradeDecision = strategy.decide();

      if (!decision.shouldTrade) {
        logger.info(`[${state.tokenName}] Skipping: ${decision.reason}`);
        return;
      }

      logger.info(
        `[${state.tokenName}] Executing: ${decision.direction} $${decision.amountUsd.toFixed(2)} | ${decision.reason}`
      );

      const result = await strategy.execute(decision);
      state.lastTradeTime = Date.now();

      if (result) {
        if (result.success) {
          logger.info(`[${state.tokenName}] Trade OK: ${result.txHash}`);
        } else {
          logger.warn(`[${state.tokenName}] Trade FAILED: ${result.error}`);
          state.error = result.error;
        }
      }
    } catch (error: any) {
      logger.error(`[${state.tokenName}] Trade error: ${error.message}`);
      state.error = error.message;
    }
  }

  private async checkRebalances(): Promise<void> {
    const hour = new Date().getUTCHours();
    const isEndOfDay = hour >= 22;

    for (const [key, state] of this.tokenStates) {
      if (state.mode !== "delta_neutral") continue;

      const rebalance = this.tracker.getRebalanceNeeded(state.tokenName);
      if (!rebalance.needed) continue;

      if (!isEndOfDay && rebalance.amountUsd < state.params.tradeAmountUsd * 3) {
        continue;
      }

      logger.info(
        `[Rebalance] ${state.tokenName} needs ${rebalance.direction} $${rebalance.amountUsd.toFixed(2)} to neutralize`
      );

      try {
        const walletGroup = this.walletManager.getTokenGroup(key);
        const wallet = walletGroup.nextRoundRobin();
        const token = this.registry.get(key);
        if (!token) continue;

        const amountIn =
          rebalance.direction === "buy"
            ? this.swapService.amountFromUsd(rebalance.amountUsd, token.pairDecimals)
            : await this.priceFeed.usdToTokenAmount(rebalance.amountUsd, token);

        const result = await this.swapService.executeSwap(
          wallet.wallet,
          token,
          amountIn,
          rebalance.direction,
          state.params.maxSlippageBps,
          state.params.maxPriceImpactBps
        );

        this.tracker.recordTrade(result, rebalance.amountUsd);
      } catch (err: any) {
        if (err instanceof PriceUnavailableError) {
          logger.warn(
            `[Rebalance] ${state.tokenName} skipped — price unavailable; will retry next hour`
          );
          continue;
        }
        logger.error(
          `[Rebalance] ${state.tokenName} failed: ${err.message ?? err}`
        );
      }
    }
  }

  // ─── Token CRUD (called from dashboard API) ─────────────────────────

  getRegistry(): TokenRegistry {
    return this.registry;
  }

  getDetector(): TokenDetector {
    return this.detector;
  }

  /**
   * Add a new token to the registry and bring it into the running
   * engine's state. The detector + registry have already validated the
   * input by the time this is called from the API.
   */
  async addToken(input: {
    address: string;
    name?: string;
    enabled?: boolean;
    walletSelector?: string;
  }): Promise<TokenConfig> {
    const detected = await this.detector.detect(input.address);

    const walletIndices = parseWalletSelector(
      input.walletSelector ?? this.config.defaultWalletSelector,
      this.walletManager.count()
    );

    if (walletIndices.length === 0) {
      throw new TokenValidationError(
        "Token requires at least one wallet — none matched the selector."
      );
    }

    const token: TokenConfig = {
      key: detected.key,
      name: input.name?.trim() || detected.name || detected.symbol,
      address: detected.address,
      decimals: detected.decimals,
      pairToken: this.config.usdtAddress,
      pairDecimals: 18,
      pairAddress: detected.pairAddress,
      route: detected.route,
      wbnbUsdtPair: detected.wbnbUsdtPair,
      enabled: input.enabled ?? false,
      walletIndices,
    };

    const stored = this.registry.add(token);
    this.bootstrapTokenState(stored);

    // If engine is already running and the new token is enabled,
    // probe its pair and start the loop right away.
    if (this.running && stored.enabled) {
      const state = this.tokenStates.get(stored.key);
      const health = await checkTokenHealth(stored, this.provider);
      if (state) {
        state.available = health.available;
        state.healthError = health.error;
      }
      if (state?.available && state.mode !== "stopped") {
        this.startTokenLoop(stored.key);
      }
    }

    return stored;
  }

  /**
   * Update token-level fields (enabled, walletIndices, name, decimals).
   * Trading params and mode go through the existing setMode/updateParams
   * paths because they live on the engine state, not the registry.
   */
  updateToken(
    key: string,
    patch: {
      name?: string;
      enabled?: boolean;
      walletSelector?: string;
      decimals?: number;
    }
  ): TokenConfig {
    const existing = this.registry.get(key);
    if (!existing) throw new TokenValidationError(`Unknown token "${key}"`);

    const registryPatch: Parameters<TokenRegistry["update"]>[1] = {};
    if (patch.name !== undefined) registryPatch.name = patch.name.trim();
    if (patch.decimals !== undefined) registryPatch.decimals = patch.decimals;
    if (patch.enabled !== undefined) registryPatch.enabled = patch.enabled;
    if (patch.walletSelector !== undefined) {
      registryPatch.walletIndices = parseWalletSelector(
        patch.walletSelector,
        this.walletManager.count()
      );
    }

    const updated = this.registry.update(key, registryPatch);

    // ── Reconcile in-memory state with the new registry entry ───────
    const state = this.tokenStates.get(key);
    const wasEnabled = !!state?.enabled;
    const willBeEnabled = updated.enabled;

    if (state && registryPatch.name) {
      state.tokenName = updated.name;
    }
    if (state && registryPatch.walletIndices) {
      state.walletIndices = updated.walletIndices;
      this.walletManager.createTokenGroup(key, updated.walletIndices);
    }

    if (!wasEnabled && willBeEnabled) {
      // Disabled → enabled: bootstrap and (if engine running) start.
      this.tokenStates.delete(key);
      this.bootstrapTokenState(updated);
      if (this.running) {
        const newState = this.tokenStates.get(key);
        if (newState) {
          // Schedule async health probe + loop start without blocking.
          checkTokenHealth(updated, this.provider).then((h) => {
            newState.available = h.available;
            newState.healthError = h.error;
            if (h.available && newState.mode !== "stopped") {
              this.startTokenLoop(key);
            }
          });
        }
      }
    } else if (wasEnabled && !willBeEnabled) {
      // Enabled → disabled: stop loop, drop strategy, mark state.
      this.stopTokenLoop(key);
      this.strategies.delete(key);
      this.walletManager.removeTokenGroup(key);
      if (state) {
        state.enabled = false;
        state.mode = "stopped";
        state.available = false;
      }
    } else if (willBeEnabled && state) {
      // Both enabled before & after — propagate the new config to the
      // strategy so it sees the latest token name/decimals.
      const strategy = this.strategies.get(key);
      if (strategy) strategy.updateTokenConfig(updated);
    }

    return updated;
  }

  /** Remove a token entirely from the registry and stop its loop. */
  removeToken(key: string): boolean {
    const k = key.toUpperCase();
    const token = this.registry.get(k);
    if (!token) return false;

    this.stopTokenLoop(k);
    this.strategies.delete(k);
    this.walletManager.removeTokenGroup(k);
    this.tokenStates.delete(k);
    this.priceFeed.clearCache(token.address);

    return this.registry.remove(k);
  }

  // ─── Existing dashboard API (mode, params, wallets) ─────────────────

  setMode(tokenKey: string, mode: TradingMode): void {
    const state = this.tokenStates.get(tokenKey);
    const token = this.registry.get(tokenKey);
    if (!state || !token) {
      throw new Error(`Unknown token: ${tokenKey}`);
    }
    if (!state.enabled) {
      throw new Error(`Token ${tokenKey} is disabled — enable it first.`);
    }
    if (!state.available && mode !== "stopped") {
      throw new Error(
        `Pair not available for ${tokenKey}: ${state.healthError ?? "unknown"}`
      );
    }

    const wasRunning = state.running;
    if (wasRunning) this.stopTokenLoop(tokenKey);

    state.mode = mode;
    state.params.mode = mode;
    state.error = undefined;

    this.createStrategy(tokenKey, token, state.params);

    if (mode !== "stopped" && this.running) {
      this.startTokenLoop(tokenKey);
    }

    logger.info(`[${state.tokenName}] Mode changed to: ${mode}`);
  }

  updateParams(tokenKey: string, params: Partial<TradingParams>): void {
    const state = this.tokenStates.get(tokenKey);
    const strategy = this.strategies.get(tokenKey);
    if (!state) throw new Error(`Unknown token: ${tokenKey}`);

    Object.assign(state.params, params);
    if (strategy) strategy.updateParams(params);

    logger.info(`[${state.tokenName}] Params updated: ${JSON.stringify(params)}`);
  }

  addWallet(
    privateKey: string,
    tokenKeys?: string[]
  ): { label: string; address: string } {
    const info = this.walletManager.addWallet(privateKey, tokenKeys);
    return { label: info.label, address: info.address };
  }

  /**
   * Snapshot for dashboard /api/status. Tokens are returned in registry
   * order so the UI keeps a stable layout across refreshes.
   */
  getStatus(): EngineStatus {
    const ordered: TokenState[] = [];
    for (const t of this.registry.list()) {
      const s = this.tokenStates.get(t.key);
      if (s) ordered.push(s);
    }
    return {
      running: this.running,
      uptime: this.running ? Date.now() - this.startTime : 0,
      tokens: ordered,
      wallets: this.walletManager.getSummary(),
      dailySummary: this.tracker.getDashboardSummary(),
      recentTrades: this.tracker.getRecentTrades(50),
      prices: this.priceFeed.getAllPrices(),
    };
  }

  getTracker(): DailyTracker {
    return this.tracker;
  }
}
