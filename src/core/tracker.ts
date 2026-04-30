import { SwapResult } from "../services/swap";
import { logger } from "../utils/logger";
import * as fs from "fs";
import * as path from "path";

/**
 * Tracks daily trading activity per token to enforce delta-neutral constraints
 * and provide analytics for the dashboard.
 *
 * State is persisted to disk (JSON) so that a bot restart does not lose
 * progress toward the daily volume target or break delta-neutral accounting.
 */

export interface DailyRecord {
  date: string; // YYYY-MM-DD
  tokenName: string;
  totalBuyUsd: number;
  totalSellUsd: number;
  buyCount: number;
  sellCount: number;
  netUsd: number; // positive = net bought, negative = net sold
  trades: TradeRecord[];
}

export interface TradeRecord {
  timestamp: number;
  txHash: string;
  direction: "buy" | "sell";
  amountIn: string;
  amountOut: string;
  walletAddress: string;
  estimatedUsd: number;
  /** On-curve price impact in bps (10000 = 100%); 0 if not measured. */
  priceImpactBps: number;
  success: boolean;
  error?: string;
}

export class DailyTracker {
  // token -> date -> DailyRecord
  private records: Map<string, Map<string, DailyRecord>> = new Map();
  /** Directory where daily JSON state files are stored */
  private dataDir: string;
  /** Debounce handle for save — avoids hammering disk on rapid trades */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param dataDir Directory for state files (created if missing).
   *                Defaults to `./data/tracker`.
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), "data", "tracker");
    this.ensureDataDir();
    this.loadFromDisk();
  }

  private todayKey(): string {
    return new Date().toISOString().split("T")[0];
  }

  private getOrCreateRecord(tokenName: string, date?: string): DailyRecord {
    const d = date || this.todayKey();
    if (!this.records.has(tokenName)) {
      this.records.set(tokenName, new Map());
    }
    const tokenRecords = this.records.get(tokenName)!;
    if (!tokenRecords.has(d)) {
      tokenRecords.set(d, {
        date: d,
        tokenName,
        totalBuyUsd: 0,
        totalSellUsd: 0,
        buyCount: 0,
        sellCount: 0,
        netUsd: 0,
        trades: [],
      });
    }
    return tokenRecords.get(d)!;
  }

  /**
   * Record a completed trade.
   */
  recordTrade(result: SwapResult, estimatedUsd: number): void {
    const record = this.getOrCreateRecord(result.tokenName);

    const trade: TradeRecord = {
      timestamp: Date.now(),
      txHash: result.txHash,
      direction: result.direction,
      amountIn: result.amountIn,
      amountOut: result.amountOut,
      walletAddress: result.walletAddress,
      estimatedUsd,
      priceImpactBps: result.priceImpactBps ?? 0,
      success: result.success,
      error: result.error,
    };

    record.trades.push(trade);

    if (result.success) {
      if (result.direction === "buy") {
        record.totalBuyUsd += estimatedUsd;
        record.buyCount++;
      } else {
        record.totalSellUsd += estimatedUsd;
        record.sellCount++;
      }
      record.netUsd = record.totalBuyUsd - record.totalSellUsd;
    }

    logger.debug(
      `[Tracker] ${result.tokenName} | ${result.direction} $${estimatedUsd.toFixed(2)} | ` +
        `Net: $${record.netUsd.toFixed(2)} | Buys: ${record.buyCount} Sells: ${record.sellCount}`
    );

    // Persist to disk (debounced — 2 s after last write to batch rapid trades)
    this.scheduleSave();
  }

  /**
   * Get today's record for a token.
   */
  getToday(tokenName: string): DailyRecord {
    return this.getOrCreateRecord(tokenName);
  }

  /**
   * Get the current net position for a token today (in USD).
   * Positive = net bought, negative = net sold.
   */
  getTodayNetUsd(tokenName: string): number {
    return this.getOrCreateRecord(tokenName).netUsd;
  }

  /**
   * Get today's total volume (buys + sells) for a token.
   */
  getTodayVolumeUsd(tokenName: string): number {
    const r = this.getOrCreateRecord(tokenName);
    return r.totalBuyUsd + r.totalSellUsd;
  }

  /**
   * Determine the next direction for delta-neutral mode.
   * Returns the direction that brings net closer to zero.
   * If net is near zero, returns a random direction.
   */
  getDeltaNeutralDirection(tokenName: string): "buy" | "sell" {
    const net = this.getTodayNetUsd(tokenName);
    if (net > 1) return "sell";
    if (net < -1) return "buy";
    return Math.random() < 0.5 ? "buy" : "sell";
  }

  /**
   * Check if we need a rebalancing trade at end of day.
   */
  getRebalanceNeeded(
    tokenName: string
  ): { needed: boolean; direction: "buy" | "sell"; amountUsd: number } {
    const net = this.getTodayNetUsd(tokenName);
    const threshold = 5;
    if (Math.abs(net) <= threshold) {
      return { needed: false, direction: "buy", amountUsd: 0 };
    }
    return {
      needed: true,
      direction: net > 0 ? "sell" : "buy",
      amountUsd: Math.abs(net),
    };
  }

  getAllRecords(): DailyRecord[] {
    const all: DailyRecord[] = [];
    for (const [, dateMap] of this.records) {
      for (const [, record] of dateMap) {
        all.push(record);
      }
    }
    return all.sort((a, b) => b.date.localeCompare(a.date));
  }

  getDashboardSummary(): Array<{
    tokenName: string;
    date: string;
    totalBuyUsd: number;
    totalSellUsd: number;
    netUsd: number;
    totalVolume: number;
    tradeCount: number;
  }> {
    const today = this.todayKey();
    const summaries = [];
    for (const [tokenName, dateMap] of this.records) {
      const record = dateMap.get(today);
      if (record) {
        summaries.push({
          tokenName: record.tokenName,
          date: record.date,
          totalBuyUsd: record.totalBuyUsd,
          totalSellUsd: record.totalSellUsd,
          netUsd: record.netUsd,
          totalVolume: record.totalBuyUsd + record.totalSellUsd,
          tradeCount: record.buyCount + record.sellCount,
        });
      }
    }
    return summaries;
  }

  getRecentTrades(limit: number = 50): TradeRecord[] {
    const allTrades: (TradeRecord & { tokenName: string })[] = [];
    for (const [tokenName, dateMap] of this.records) {
      for (const [, record] of dateMap) {
        for (const trade of record.trades) {
          allTrades.push({ ...trade, tokenName });
        }
      }
    }
    return allTrades
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  // ─── Disk Persistence ───────────────────────────────────────────

  private ensureDataDir(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (err: any) {
      logger.error(`Failed to create tracker data dir ${this.dataDir}: ${err.message}`);
    }
  }

  private stateFile(date: string): string {
    return path.join(this.dataDir, `tracker-${date}.json`);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), 2000);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }

  private saveToDisk(): void {
    const today = this.todayKey();
    const todayRecords: DailyRecord[] = [];

    for (const [, dateMap] of this.records) {
      const rec = dateMap.get(today);
      if (rec) todayRecords.push(rec);
    }

    if (todayRecords.length === 0) return;

    const filePath = this.stateFile(today);
    try {
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(todayRecords, null, 2), "utf-8");
      fs.renameSync(tmp, filePath);
      logger.debug(`[Tracker] State saved to ${filePath}`);
    } catch (err: any) {
      logger.error(`[Tracker] Failed to save state: ${err.message}`);
    }
  }

  private loadFromDisk(): void {
    const today = this.todayKey();
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .split("T")[0];

    for (const date of [yesterday, today]) {
      const filePath = this.stateFile(date);
      if (!fs.existsSync(filePath)) continue;

      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const records: DailyRecord[] = JSON.parse(raw);
        for (const rec of records) {
          if (!this.records.has(rec.tokenName)) {
            this.records.set(rec.tokenName, new Map());
          }
          this.records.get(rec.tokenName)!.set(rec.date, rec);
        }
        logger.info(
          `[Tracker] Loaded ${records.length} record(s) from ${filePath}`
        );
      } catch (err: any) {
        logger.warn(`[Tracker] Could not load ${filePath}: ${err.message}`);
      }
    }
  }
}
