import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DeltaNeutralStrategy } from "../strategies/delta-neutral";
import { WeeklyAnchor } from "../services/weekly-anchor";
import { DailyTracker } from "../core/tracker";

function makeStubs(tmpDir: string, currentPrice: number, overrides: any = {}) {
  const params: any = {
    mode: "delta_neutral",
    tradeAmountUsd: 10,
    intervalSeconds: 300,
    variancePercent: 20,
    dailyVolumeTargetUsd: 1_000_000,
    maxSlippageBps: 100,
    maxPriceImpactBps: 1000,
    dcaBiasPercent: 70,
    dailyDriftMinPct: 1,
    dailyDriftMaxPct: 5,
    anchorPullStrength: 3,
    biasStrength: 5,
    tradeSizeSigma: 0.4,
    quietPeriodProbability: 0, // deterministic
    targetPrice: 0,
    targetPriceUnit: "USD_PER_TOKEN",
    targetPriceStrength: 10,
    targetPriceMode: "hold",
    targetPriceReachedTolerancePct: 1,
    targetPriceMaxDeviationPct: 0,
    pBuyMin: 0.15,
    pBuyMax: 0.85,
    ...overrides,
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

  const strategy = () =>
    new DeltaNeutralStrategy(
      tokenConfig,
      params,
      walletGroup,
      tracker,
      swapService,
      priceFeed,
      anchor
    );

  return { params, anchor, strategy, tmpDir };
}

/** Fraction of N decisions that came back as buys. */
function buyShare(strategy: DeltaNeutralStrategy, n = 2000): number {
  let buys = 0;
  for (let i = 0; i < n; i++) {
    if (strategy.decide().direction === "buy") buys++;
  }
  return buys / n;
}

describe("price defense end to end", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luniox-defense-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defends hard when the price is well below the target", () => {
    // Price 20% under a defended $1. This is the scenario the anchor alone
    // cannot handle: it would have re-based to 0.8 and called that normal.
    const s = makeStubs(tmpDir, 0.8, { targetPrice: 1 });
    expect(buyShare(s.strategy())).toBeGreaterThan(0.8);
  });

  it("sells into a price well above the target", () => {
    const s = makeStubs(tmpDir, 1.2, { targetPrice: 1 });
    expect(buyShare(s.strategy())).toBeLessThan(0.2);
  });

  it("keeps counter-direction flow even at full saturation", () => {
    // A bot that only ever buys is trivially readable on-chain.
    const s = makeStubs(tmpDir, 0.5, { targetPrice: 1 });
    const share = buyShare(s.strategy());
    expect(share).toBeGreaterThan(0.8);
    expect(share).toBeLessThan(0.92);
  });

  it("keeps defending as the price falls further — pressure does not decay", () => {
    const near = makeStubs(tmpDir, 0.97, { targetPrice: 1 });
    const far = makeStubs(tmpDir, 0.75, { targetPrice: 1 });
    expect(buyShare(far.strategy())).toBeGreaterThan(buyShare(near.strategy()));
  });

  it("trades delta-neutral when no target is set", () => {
    // Regression guard: existing deployments must not change behaviour.
    // Pin today's drift target to the live price so the anchor bias is 0.
    const s = makeStubs(tmpDir, 1, { targetPrice: 0 });
    (s.anchor as any).state.today = {
      open: 1,
      target: 1,
      openedAt: new Date().toISOString(),
    };
    expect(buyShare(s.strategy())).toBeGreaterThan(0.45);
    expect(buyShare(s.strategy())).toBeLessThan(0.55);
  });

  it("accepts a TOKEN_PER_USD target and defends the same level", () => {
    const perToken = makeStubs(tmpDir, 0.8, { targetPrice: 1 });
    const perUsd = makeStubs(tmpDir, 0.8, {
      targetPrice: 1,
      targetPriceUnit: "TOKEN_PER_USD",
    });
    // 1 USD_PER_TOKEN and 1 TOKEN_PER_USD both normalise to $1.
    expect(buyShare(perUsd.strategy())).toBeCloseTo(
      buyShare(perToken.strategy()),
      1
    );
  });

  it("reports the defended level in the decision reason", () => {
    const s = makeStubs(tmpDir, 0.8, { targetPrice: 1 });
    const d = s.strategy().decide();
    expect(d.reason).toContain("Defending");
  });
});

describe("reach mode", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luniox-reach-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps pushing in hold mode after the target is touched", () => {
    const s = makeStubs(tmpDir, 1.0, {
      targetPrice: 1,
      targetPriceMode: "hold",
    });
    s.anchor.observePrice(1.0);
    expect(s.anchor.targetReached()).toBeNull();
  });

  it("stands down once the price lands inside the tolerance band", () => {
    const s = makeStubs(tmpDir, 0.995, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 1,
    });
    s.anchor.observePrice(0.995);
    expect(s.anchor.targetReached()).not.toBeNull();
    expect(s.anchor.effectiveParams().targetPrice).toBe(0);
  });

  it("stands down when the price gaps clean over the tolerance band", () => {
    // A thin pool can jump straight past a 1% band in one trade. Without
    // the crossing check the bot would keep buying a price that overshot.
    const s = makeStubs(tmpDir, 0.9, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 0.1,
    });
    s.anchor.observePrice(0.9); // below
    expect(s.anchor.targetReached()).toBeNull();
    s.anchor.observePrice(1.15); // gapped straight over
    expect(s.anchor.targetReached()).not.toBeNull();
  });

  it("does not stand down while still approaching from one side", () => {
    const s = makeStubs(tmpDir, 0.9, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 0.1,
    });
    for (const p of [0.9, 0.92, 0.95, 0.97]) s.anchor.observePrice(p);
    expect(s.anchor.targetReached()).toBeNull();
  });

  it("trades delta-neutral after standing down", () => {
    const s = makeStubs(tmpDir, 0.995, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 1,
    });
    (s.anchor as any).state.today = {
      open: 0.995,
      target: 0.995,
      openedAt: new Date().toISOString(),
    };
    const share = buyShare(s.strategy());
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
  });

  it("survives a restart — arrival is persisted, not re-derived", () => {
    const s = makeStubs(tmpDir, 0.995, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 1,
    });
    s.anchor.observePrice(0.995);

    const reloaded = new WeeklyAnchor(
      "ABC",
      path.join(tmpDir, "anchor"),
      () => 0.9,
      s.params
    );
    expect(reloaded.targetReached()).not.toBeNull();
  });

  it("re-arms when the operator moves the target", () => {
    const s = makeStubs(tmpDir, 0.995, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 1,
    });
    s.anchor.observePrice(0.995);
    expect(s.anchor.targetReached()).not.toBeNull();

    // A stale arrival must not silence a brand new goal.
    s.anchor.updateParams({ targetPrice: 2 });
    expect(s.anchor.targetReached()).toBeNull();
  });

  it("re-arms when the operator changes the price unit", () => {
    const s = makeStubs(tmpDir, 0.995, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 1,
    });
    s.anchor.observePrice(0.995);
    s.anchor.updateParams({ targetPriceUnit: "TOKEN_PER_USD" });
    expect(s.anchor.targetReached()).toBeNull();
  });

  it("re-arms explicitly via clearTargetReached", () => {
    const s = makeStubs(tmpDir, 0.995, {
      targetPrice: 1,
      targetPriceMode: "reach",
      targetPriceReachedTolerancePct: 1,
    });
    s.anchor.observePrice(0.995);
    s.anchor.clearTargetReached();
    expect(s.anchor.targetReached()).toBeNull();
  });
});

describe("daily drift with a defended price", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luniox-drift-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rolls the daily target upward when the day opens under the defended price", () => {
    // The anchor-only build would centre the roll on today's open and
    // happily drift further down. With a target set, gravity points up.
    let ups = 0;
    for (let i = 0; i < 200; i++) {
      const dir = fs.mkdtempSync(path.join(tmpDir, `roll-${i}-`));
      const s = makeStubs(dir, 0.8, { targetPrice: 1 });
      s.anchor.resetAnchor(new Date("2026-05-06T00:00:00Z"));
      const today = s.anchor.getState().today!;
      if (today.target > today.open) ups++;
    }
    expect(ups / 200).toBeGreaterThan(0.85);
  });

  it("rolls downward when the day opens above the defended price", () => {
    let downs = 0;
    for (let i = 0; i < 200; i++) {
      const dir = fs.mkdtempSync(path.join(tmpDir, `roll-${i}-`));
      const s = makeStubs(dir, 1.2, { targetPrice: 1 });
      s.anchor.resetAnchor(new Date("2026-05-06T00:00:00Z"));
      const today = s.anchor.getState().today!;
      if (today.target < today.open) downs++;
    }
    expect(downs / 200).toBeGreaterThan(0.85);
  });
});

describe("anchor file migration", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luniox-migrate-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps a v1 anchor rather than re-basing the token on deploy", () => {
    const dir = path.join(tmpDir, "anchor");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ABC.json"),
      JSON.stringify({
        version: 1,
        anchor: { price: 1.23, setAt: "2026-05-04T00:00:00.000Z" },
        today: {
          open: 1.2,
          target: 1.25,
          openedAt: "2026-05-05T00:00:00.000Z",
        },
      })
    );

    const anchor = new WeeklyAnchor("ABC", dir, () => 1.2, {
      targetPrice: 0,
    } as any);
    const state = anchor.getState();
    expect(state.version).toBe(2);
    expect(state.anchor!.price).toBe(1.23);
    expect(state.today!.target).toBe(1.25);
    expect(state.reached).toBeNull();
  });

  it("rejects a structurally broken file instead of crashing on it", () => {
    const dir = path.join(tmpDir, "anchor");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ABC.json"),
      JSON.stringify({ version: 2, anchor: { price: "nope" }, today: null })
    );
    const anchor = new WeeklyAnchor("ABC", dir, () => 1, {
      targetPrice: 0,
    } as any);
    expect(anchor.getState().anchor).toBeNull();
  });
});
