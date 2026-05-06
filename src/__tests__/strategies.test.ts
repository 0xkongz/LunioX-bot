import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DeltaNeutralStrategy } from "../strategies/delta-neutral";
import { WeeklyAnchor } from "../services/weekly-anchor";
import { DailyTracker } from "../core/tracker";

function makeStubs(tmpDir: string, currentPrice: number) {
  const params: any = {
    mode: "delta_neutral",
    tradeAmountUsd: 10,
    intervalSeconds: 300,
    variancePercent: 20,
    dailyVolumeTargetUsd: 1000,
    maxSlippageBps: 100,
    maxPriceImpactBps: 1000,
    dcaBiasPercent: 70,
    dailyDriftMinPct: 1,
    dailyDriftMaxPct: 5,
    anchorPullStrength: 3,
    biasStrength: 5,
    tradeSizeSigma: 0.4,
    quietPeriodProbability: 0, // disable for deterministic tests
  };
  const tokenConfig: any = {
    key: "ABC",
    name: "ABC",
    address: "0x" + "11".repeat(20),
    decimals: 18,
    pairToken: "0x55d398326f99059fF775485246999027B3197955",
    pairDecimals: 18,
    pairAddress: "0x" + "22".repeat(20),
    route: "direct",
    enabled: true,
    walletIndices: [0],
  };
  const walletInfo = {
    index: 0,
    label: "Wallet-1",
    address: "0x" + "ff".repeat(20),
    wallet: {} as any,
    bnbBalance: 1n,
  };
  const walletGroup: any = {
    nextRoundRobin: () => walletInfo,
    get: () => walletInfo,
    getAll: () => [walletInfo],
    count: () => 1,
  };
  const tracker = new DailyTracker(path.join(tmpDir, "tracker"));
  const swapService: any = { amountFromUsd: () => 0n };
  const priceFeed: any = {
    getAllPrices: () => [
      {
        tokenName: "ABC",
        tokenAddress: tokenConfig.address,
        priceUsd: currentPrice,
        liquidity: "0",
        timestamp: Date.now(),
      },
    ],
  };
  const anchor = new WeeklyAnchor(
    "ABC",
    path.join(tmpDir, "anchor"),
    () => currentPrice,
    params
  );
  anchor.tick(new Date("2026-05-05T10:00:00Z"));
  return { params, tokenConfig, walletGroup, tracker, swapService, priceFeed, anchor };
}

describe("DeltaNeutralStrategy direction selection", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luniox-strat-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("biases toward buy when price is below target", () => {
    const s = makeStubs(tmpDir, 1);
    // Force anchor.today.target to be 1.05 (5% above current 1)
    (s.anchor as any).state.today = {
      open: 1,
      target: 1.05,
      openedAt: new Date().toISOString(),
    };
    const strategy = new DeltaNeutralStrategy(
      s.tokenConfig,
      s.params,
      s.walletGroup,
      s.tracker,
      s.swapService,
      s.priceFeed,
      s.anchor
    );
    let buys = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const d = strategy.decide();
      if (d.direction === "buy") buys++;
    }
    // r = (1.05 - 1)/1 = 0.05, biasStrength=5 → bias=0.25, P(buy)=0.75
    // Expect 700-800 buys out of 1000.
    expect(buys).toBeGreaterThan(700);
    expect(buys).toBeLessThan(800);
  });

  it("biases toward sell when price is above target", () => {
    const s = makeStubs(tmpDir, 1.05);
    (s.anchor as any).state.today = {
      open: 1,
      target: 1.0,
      openedAt: new Date().toISOString(),
    };
    const strategy = new DeltaNeutralStrategy(
      s.tokenConfig,
      s.params,
      s.walletGroup,
      s.tracker,
      s.swapService,
      s.priceFeed,
      s.anchor
    );
    let sells = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const d = strategy.decide();
      if (d.direction === "sell") sells++;
    }
    // r = (1.0 - 1.05)/1.05 ≈ -0.0476, biasStrength=5 → bias=-0.238, P(buy)=0.262
    // Expect 700-780 sells out of 1000.
    expect(sells).toBeGreaterThan(700);
    expect(sells).toBeLessThan(780);
  });

  it("at-target gives near-50/50 split", () => {
    const s = makeStubs(tmpDir, 1);
    (s.anchor as any).state.today = {
      open: 1,
      target: 1,
      openedAt: new Date().toISOString(),
    };
    const strategy = new DeltaNeutralStrategy(
      s.tokenConfig,
      s.params,
      s.walletGroup,
      s.tracker,
      s.swapService,
      s.priceFeed,
      s.anchor
    );
    let buys = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const d = strategy.decide();
      if (d.direction === "buy") buys++;
    }
    expect(buys).toBeGreaterThan(450);
    expect(buys).toBeLessThan(550);
  });
});
