import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WeeklyAnchor } from "../services/weekly-anchor";

function makeParams(overrides: any = {}) {
  return {
    mode: "delta_neutral" as const,
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
    quietPeriodProbability: 0.005,
    ...overrides,
  };
}

describe("WeeklyAnchor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luniox-anchor-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("first-run path", () => {
    it("creates anchor + today on first tick when no file exists", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 0.01703, makeParams());
      const now = new Date("2026-05-05T10:00:00Z");
      a.tick(now);
      const state = a.getState();
      expect(state.anchor!.price).toBe(0.01703);
      expect(state.today!.open).toBe(0.01703);
      expect(state.today!.target).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(tmpDir, "ABC.json"))).toBe(true);
    });
  });

  describe("anchor pull formula", () => {
    it("at d=0 returns P(up) = 0.5", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 1, makeParams());
      expect(a.directionProbabilityForRoll(0)).toBeCloseTo(0.5, 5);
    });
    it("at d=+0.05 with pullStrength=3 returns P(up) = 0.35", () => {
      const a = new WeeklyAnchor(
        "ABC",
        tmpDir,
        () => 1,
        makeParams({ anchorPullStrength: 3 })
      );
      expect(a.directionProbabilityForRoll(0.05)).toBeCloseTo(0.35, 5);
    });
    it("at d=-0.05 with pullStrength=3 returns P(up) = 0.65", () => {
      const a = new WeeklyAnchor(
        "ABC",
        tmpDir,
        () => 1,
        makeParams({ anchorPullStrength: 3 })
      );
      expect(a.directionProbabilityForRoll(-0.05)).toBeCloseTo(0.65, 5);
    });
    it("clamps at 0.1 / 0.9 for extreme drift", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 1, makeParams());
      expect(a.directionProbabilityForRoll(0.5)).toBe(0.1);
      expect(a.directionProbabilityForRoll(-0.5)).toBe(0.9);
    });
  });

  describe("within-day bias formula", () => {
    it("at r=0 returns P(buy) = 0.5", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 1, makeParams());
      expect(a.directionProbabilityForTrade(0)).toBeCloseTo(0.5, 5);
    });
    it("at r=+0.03 with biasStrength=5 returns P(buy) = 0.65", () => {
      const a = new WeeklyAnchor(
        "ABC",
        tmpDir,
        () => 1,
        makeParams({ biasStrength: 5 })
      );
      expect(a.directionProbabilityForTrade(0.03)).toBeCloseTo(0.65, 5);
    });
    it("clamps at 0.2 / 0.8", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 1, makeParams());
      expect(a.directionProbabilityForTrade(0.5)).toBe(0.8);
      expect(a.directionProbabilityForTrade(-0.5)).toBe(0.2);
    });
  });

  describe("persistence round-trip", () => {
    it("loads previously saved state on construction", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 0.02, makeParams());
      const now = new Date("2026-05-05T10:00:00Z");
      a.tick(now);
      const before = a.getState();
      const b = new WeeklyAnchor("ABC", tmpDir, () => 0.02, makeParams());
      const after = b.getState();
      expect(after.anchor).toEqual(before.anchor);
      expect(after.today).toEqual(before.today);
    });
  });

  describe("daily roll on new day", () => {
    it("rolls fresh today when openedAt is from prior day", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 0.02, makeParams());
      a.tick(new Date("2026-05-05T10:00:00Z"));
      const todayBefore = a.getState().today!;

      // Bot runs into next day; new tick same day is no-op.
      a.tick(new Date("2026-05-05T15:00:00Z"));
      expect(a.getState().today!.openedAt).toBe(todayBefore.openedAt);

      // Cross into 5/6.
      a.tick(new Date("2026-05-06T00:30:00Z"));
      const todayAfter = a.getState().today!;
      expect(todayAfter.openedAt).not.toBe(todayBefore.openedAt);
      expect(todayAfter.open).toBe(0.02); // current price
    });
  });

  describe("weekly anchor reset on Monday", () => {
    it("resets anchor when a Monday 00:00 UTC is crossed", () => {
      // 2026-05-05 is a Tuesday. Anchor was set today.
      const a = new WeeklyAnchor("ABC", tmpDir, () => 0.02, makeParams());
      a.tick(new Date("2026-05-05T10:00:00Z"));
      const anchorBefore = a.getState().anchor!;

      // Cross into Monday 2026-05-11.
      a.tick(new Date("2026-05-11T00:30:00Z"));
      const anchorAfter = a.getState().anchor!;
      expect(anchorAfter.setAt).not.toBe(anchorBefore.setAt);
      // setAt should be the 5/11 Monday, not the original Tuesday.
      expect(new Date(anchorAfter.setAt).getUTCDay()).toBe(1); // Monday
    });
  });

  describe("manual reset", () => {
    it("resetAnchor clears + rolls fresh state", () => {
      const a = new WeeklyAnchor("ABC", tmpDir, () => 0.02, makeParams());
      a.tick(new Date("2026-05-05T10:00:00Z"));
      const before = a.getState();
      a.resetAnchor(new Date("2026-05-05T11:00:00Z"));
      const after = a.getState();
      expect(after.anchor!.setAt).not.toBe(before.anchor!.setAt);
      expect(after.today!.openedAt).not.toBe(before.today!.openedAt);
    });
  });

  describe("daily target generation", () => {
    it("magnitude is in [min, max] range", () => {
      const a = new WeeklyAnchor(
        "ABC",
        tmpDir,
        () => 1,
        makeParams({ dailyDriftMinPct: 1, dailyDriftMaxPct: 5 })
      );
      for (let i = 0; i < 200; i++) {
        a.resetAnchor(new Date(`2026-05-05T${10 + (i % 12)}:00:00Z`));
        const t = a.getState().today!;
        const driftPct = Math.abs((t.target - t.open) / t.open) * 100;
        expect(driftPct).toBeGreaterThanOrEqual(0.99); // 1% with tiny float slack
        expect(driftPct).toBeLessThanOrEqual(5.01);
      }
    });
  });

  describe("malformed file handling", () => {
    it("treats a file with right version but wrong shape as empty", () => {
      const filePath = path.join(tmpDir, "ABC.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          anchor: { price: "not-a-number", setAt: "2026-05-05T10:00:00Z" },
          today: null,
        })
      );
      const a = new WeeklyAnchor("ABC", tmpDir, () => 0.02, makeParams());
      // After load, malformed state should be treated as empty.
      expect(a.getState().anchor).toBeNull();
      expect(a.getState().today).toBeNull();
    });
  });
});
