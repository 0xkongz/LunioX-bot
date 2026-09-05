import { JsonRpcProvider } from "ethers";
import { connect } from "../services/provider";
import {
  AppConfig,
  TokenConfig,
  TradingMode,
  TradingParams,
  parseWalletSelector,
  validatePriceDefenseParams,
} from "../config";
import {
  buyProbability,
  targetDeviation,
  targetPriceUsd,
} from "../strategies/price-defense";
import { WalletManager } from "./wallet-manager";
import { DailyTracker } from "./tracker";
import { SwapService } from "../services/swap";
import { PriceFeed, PriceData } from "../services/price-feed";
import {
  PriceUnavailableError,
  TargetPriceGuardError,
  TokenValidationError,
} from "../services/errors";
import { TokenRegistry } from "../services/token-registry";
import { TokenDetector } from "../services/token-detector";
import { WeeklyAnchor } from "../services/weekly-anchor";
import { checkTokenHealth } from "./health";
import { BaseStrategy, TradeDecision } from "../strategies/base";
import { DeltaNeutralStrategy } from "../strategies/delta-neutral";
import { DCABuyStrategy } from "../strategies/dca-buy";
import { DCASellStrategy } from "../strategies/dca-sell";
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
  /** Set when token mode is delta_neutral. Null otherwise. */
  weeklyAnchor: { price: number; setAt: string } | null;
  /** Set when token mode is delta_neutral. Null otherwise. */
  todayTarget: { open: number; target: number; openedAt: string } | null;
  /**
   * Live price-defense readout, or null when no target price is set.
   * Lets an operator see at a glance whether the defense is actually
   * pushing — a P(buy) sitting at 0.5 with a 20% gap means something is
   * misconfigured, and that is invisible from trade history alone.
   */
  priceDefense: {
    /** Target normalised to USD per whole token. */
    targetPrice: number;
    livePrice: number;
    /** Positive when the price sits below target. */
    gapPct: number;
    /** Probability the next trade is a buy. */
    pBuy: number;
    /** ISO timestamp of reach-mode arrival, if any. */
    reachedAt: string | null;
    /** False once reach mode has stood the defense down. */
    engaged: boolean;
  } | null;
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
  private weeklyAnchors: Map<string, WeeklyAnchor> = new Map();

  private running = false;
  private startTime = 0;
  private balanceRefreshTimer: NodeJS.Timeout | null = null;
  private rebalanceTimer: NodeJS.Timeout | null = null;
  private weeklyAnchorTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.provider = connect(config.rpcUrl, config.chainId);
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

    // Refresh BNB balances regularly (independent of trading). Interval
    // is configurable via BALANCE_REFRESH_INTERVAL_SECONDS — default 2
    // minutes is a good balance between RPC load and dashboard freshness.
    this.walletManager.refreshBalances().catch((err) => {
      logger.error(`Initial balance refresh failed: ${err.message ?? err}`);
    });
    const refreshMs = Math.max(15, config.balanceRefreshIntervalSec) * 1000;
    this.balanceRefreshTimer = setInterval(() => {
      this.walletManager.refreshBalances().catch((err) => {
        logger.error(`Balance refresh failed: ${err.message ?? err}`);
      });
    }, refreshMs);
  }

  /**
   * Force a balance refresh outside the scheduled interval. Used by the
   * dashboard's manual refresh button.
   */
  async refreshBalances(): Promise<void> {
    await this.walletManager.refreshBalances();
  }

  /**
   * Reset today's tracker stats for one token. Used by the dashboard's
   * reset button. Does not stop the engine or change config — the next
   * trade just starts counting from zero.
   */
  resetTokenStats(tokenKey: string): boolean {
    const token = this.registry.get(tokenKey);
    if (!token) return false;
    return this.tracker.resetToday(token.name);
  }

  /**
   * Manually reset the weekly anchor for a token. Used by the dashboard
   * Reset Anchor button. Snapshots current price as the new anchor +
   * today.open and rolls a fresh target.
   */
  resetTokenAnchor(tokenKey: string): boolean {
    const anchor = this.weeklyAnchors.get(tokenKey.toUpperCase());
    if (!anchor) return false;
    anchor.resetAnchor();
    return true;
  }

  /**
   * Forget a reach-mode arrival for one token so the defense engages
   * again. Used by the dashboard's re-arm button.
   */
  rearmPriceDefense(tokenKey: string): boolean {
    const anchor = this.weeklyAnchors.get(tokenKey.toUpperCase());
    if (!anchor) return false;
    anchor.clearTargetReached();
    return true;
  }

  /** Return the WeeklyAnchor state for the dashboard. */
  getAnchorState(tokenKey: string): ReturnType<WeeklyAnchor["getState"]> | null {
    const anchor = this.weeklyAnchors.get(tokenKey.toUpperCase());
    return anchor ? anchor.getState() : null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Build the per-token state and strategy. Pure book-keeping; does not
   * start the trading loop. Called both at boot (for each registered
   * token) and at runtime when a new token is added.
   */
  private bootstrapTokenState(token: TokenConfig): void {
    // One params object per token, shared by the token state, the strategy
    // and the weekly anchor.
    //
    // Sharing the reference rather than handing each collaborator its own
    // copy is what makes a dashboard edit reach all three. The anchor used
    // to be constructed with a snapshot of the boot-time defaults and never
    // heard about a runtime change again, so drift bounds, anchor pull and
    // — now — the target price were silently frozen at whatever the env
    // said at start-up.
    const params: TradingParams = {
      ...this.config.defaultTradingParams,
      ...(token.enabled ? {} : { mode: "stopped" as TradingMode }),
    };

    // Create the per-token weekly anchor used by delta_neutral. Other
    // modes ignore it. Constructing eagerly means a runtime mode switch
    // to delta_neutral picks up state immediately without restart.
    const anchor = new WeeklyAnchor(
      token.key,
      this.config.anchorDataDir,
      () => {
        const cached = this.priceFeed
          .getAllPrices()
          .find(
            (p) =>
              p.tokenAddress.toLowerCase() === token.address.toLowerCase()
          );
        return cached?.priceUsd ?? 0;
      },
      params
    );
    this.weeklyAnchors.set(token.key, anchor);

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
        params,
        running: false,
        available: false,
        lastTradeTime: 0,
        nextTradeTime: 0,
        walletIndices: token.walletIndices,
        weeklyAnchor: null,
        todayTarget: null,
        priceDefense: null,
      });
      return;
    }

    this.walletManager.createTokenGroup(token.key, token.walletIndices);

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
      weeklyAnchor: null,
      todayTarget: null,
      priceDefense: null,
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
      case "delta_neutral": {
        const anchor = this.weeklyAnchors.get(key);
        if (!anchor) {
          throw new Error(`No weekly anchor for ${key}`);
        }
        strategy = new DeltaNeutralStrategy(
          token, params, walletGroup,
          this.tracker, this.swapService, this.priceFeed, anchor
        );
        break;
      }
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
      default: {
        const anchor = this.weeklyAnchors.get(key);
        if (!anchor) {
          throw new Error(`No weekly anchor for ${key}`);
        }
        strategy = new DeltaNeutralStrategy(
          token, params, walletGroup,
          this.tracker, this.swapService, this.priceFeed, anchor
        );
      }
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

    // ── Start weekly anchor ticker (after price cache is warm) ──────
    // Tick the weekly anchors every minute. Started here (after the
    // price cache has been warmed) so the first tick doesn't bootstrap
    // an anchor with price=0. Each tick is idempotent — safe to call
    // multiple times in the same minute. Cleared by stop().
    if (!this.weeklyAnchorTimer) {
      this.weeklyAnchorTimer = setInterval(() => {
        for (const [, a] of this.weeklyAnchors) {
          try {
            a.tick();
          } catch (err: any) {
            logger.error(`Anchor tick failed: ${err.message ?? err}`);
          }
        }
      }, 60 * 1000);
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
    if (this.weeklyAnchorTimer) clearInterval(this.weeklyAnchorTimer);
    this.weeklyAnchorTimer = null;
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

      const strategy = this.strategies.get(tokenKey);
      const intervalMs = strategy
        ? strategy.nextIntervalMs()
        : state.params.intervalSeconds * 1000;
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
    // The hourly rebalance previously corrected delta_neutral net drift,
    // but the new natural-drift design intentionally allows daily drift,
    // so rebalance no longer applies. The loop is kept as a hook for
    // future modes that need it.
    for (const [, state] of this.tokenStates) {
      // The hourly rebalance previously corrected delta_neutral net drift,
      // but the new natural-drift design intentionally allows daily drift,
      // so rebalance no longer applies. The loop is kept as a hook for
      // future modes that need it.
      void state;
      continue;
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
      this.weeklyAnchors.delete(key);
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
    this.weeklyAnchors.delete(k);
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

  /**
   * Apply a runtime param patch to one token.
   *
   * Beyond the plain assignment this does three things the price defense
   * needs: it validates the new values, it refuses a target price that
   * looks like a unit mix-up unless the caller forces it, and it re-arms
   * reach mode when the goal actually changes.
   *
   * @param opts.force bypass the target-price deviation guard.
   */
  updateParams(
    tokenKey: string,
    params: Partial<TradingParams>,
    opts: { force?: boolean } = {}
  ): void {
    const state = this.tokenStates.get(tokenKey);
    const strategy = this.strategies.get(tokenKey);
    if (!state) throw new Error(`Unknown token: ${tokenKey}`);

    validatePriceDefenseParams(params);

    const touchesTarget =
      params.targetPrice !== undefined || params.targetPriceUnit !== undefined;
    if (touchesTarget && !opts.force) {
      this.assertTargetPriceSane(tokenKey, {
        ...state.params,
        ...params,
      });
    }

    // Compare before assigning: the dashboard re-sends every field on
    // apply, so identical values must not count as a change and reset a
    // reach-mode arrival the operator is still relying on.
    const goalChanged = (
      ["targetPrice", "targetPriceUnit", "targetPriceMode"] as const
    ).some((k) => params[k] !== undefined && params[k] !== state.params[k]);

    Object.assign(state.params, params);
    if (strategy) strategy.updateParams(params);

    // The anchor normally shares state.params outright, so this is a no-op
    // — but anchors constructed with a detached copy (tests, and any future
    // caller) still need to see the change.
    const anchor = this.weeklyAnchors.get(tokenKey.toUpperCase());
    anchor?.updateParams(params);
    if (goalChanged) anchor?.clearTargetReached();

    logger.info(`[${state.tokenName}] Params updated: ${JSON.stringify(params)}`);
  }

  /**
   * Reject a target price that sits absurdly far from the live price.
   *
   * USD_PER_TOKEN and TOKEN_PER_USD differ by orders of magnitude for a
   * sub-cent token, so a mis-picked unit does not look wrong on the form —
   * it looks wrong only once the bot has spent the day buying into a
   * target it can never reach. Skipped when the guard is disabled, when
   * the defense is being switched off, or when there is no live price to
   * compare against (a cold cache must not block configuration).
   */
  private assertTargetPriceSane(
    tokenKey: string,
    params: TradingParams
  ): void {
    const limit = params.targetPriceMaxDeviationPct;
    if (!limit || limit <= 0) return;

    const target = targetPriceUsd(params);
    if (!target) return; // 0 disables the defense — nothing to guard.

    const token = this.registry.get(tokenKey);
    if (!token) return;
    const cached = this.priceFeed
      .getAllPrices()
      .find(
        (p) => p.tokenAddress.toLowerCase() === token.address.toLowerCase()
      );
    const live = cached?.priceUsd ?? 0;
    if (!(live > 0)) return;

    const deviationPct = Math.abs(targetDeviation(live, params)) * 100;
    if (deviationPct <= limit) return;

    throw new TargetPriceGuardError({
      livePrice: live,
      targetPrice: target,
      deviationPct,
      maxDeviationPct: limit,
    });
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
      if (!s) continue;
      const anchor = this.weeklyAnchors.get(t.key);
      const anchorState = anchor?.getState();
      ordered.push({
        ...s,
        weeklyAnchor: anchorState?.anchor ?? null,
        todayTarget: anchorState?.today ?? null,
        priceDefense: this.priceDefenseStatus(t, s, anchor, anchorState),
      });
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

  /**
   * Build the dashboard's price-defense readout for one token, mirroring
   * exactly what DeltaNeutralStrategy.decide() would compute right now.
   *
   * Returns null when the operator has configured no target, so the panel
   * stays hidden rather than showing a row of zeroes.
   */
  private priceDefenseStatus(
    token: TokenConfig,
    state: TokenState,
    anchor: WeeklyAnchor | undefined,
    anchorState: ReturnType<WeeklyAnchor["getState"]> | undefined
  ): TokenState["priceDefense"] {
    const configured = targetPriceUsd(state.params);
    if (!configured || !anchor) return null;

    const reached = anchor.targetReached();
    const defense = anchor.effectiveParams();
    // In reach mode after arrival the effective target is zeroed; keep
    // showing the configured level so the panel does not blank out at
    // exactly the moment the operator wants to see what happened.
    const engaged = targetPriceUsd(defense) > 0;

    const cached = this.priceFeed
      .getAllPrices()
      .find(
        (p) => p.tokenAddress.toLowerCase() === token.address.toLowerCase()
      );
    const livePrice = cached?.priceUsd ?? 0;

    const today = anchorState?.today ?? null;
    const r =
      today && livePrice > 0 ? (today.target - livePrice) / livePrice : 0;

    return {
      targetPrice: configured,
      livePrice,
      gapPct: livePrice > 0 ? (configured / livePrice - 1) * 100 : 0,
      pBuy: buyProbability(
        livePrice,
        defense,
        anchor.directionBiasForTrade(r)
      ),
      reachedAt: reached?.at ?? null,
      engaged,
    };
  }

  getTracker(): DailyTracker {
    return this.tracker;
  }
}
