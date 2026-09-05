import { describe, it, expect } from "vitest";
import {
  buyProbability,
  priceSkew,
  targetDeviation,
  targetPriceUsd,
} from "../strategies/price-defense";
import { validatePriceDefenseParams } from "../config";

const base = {
  targetPriceUnit: "USD_PER_TOKEN" as const,
  targetPriceStrength: 10,
  pBuyMin: 0.15,
  pBuyMax: 0.85,
};

describe("targetPriceUsd", () => {
  it("passes a USD_PER_TOKEN target through unchanged", () => {
    expect(targetPriceUsd({ ...base, targetPrice: 0.0025 })).toBeCloseTo(
      0.0025,
      12
    );
  });

  it("inverts a TOKEN_PER_USD target", () => {
    const t = targetPriceUsd({
      ...base,
      targetPrice: 400,
      targetPriceUnit: "TOKEN_PER_USD",
    });
    expect(t).toBeCloseTo(0.0025, 12);
  });

  it("treats 0, negative and absent targets as disabled", () => {
    expect(targetPriceUsd({ ...base, targetPrice: 0 })).toBe(0);
    expect(targetPriceUsd({ ...base, targetPrice: -1 })).toBe(0);
    expect(targetPriceUsd(base)).toBe(0);
  });
});

describe("priceSkew", () => {
  it("is zero when no target is configured", () => {
    expect(priceSkew(1, { ...base, targetPrice: 0 })).toBe(0);
  });

  it("is zero when the price is unavailable", () => {
    expect(priceSkew(0, { ...base, targetPrice: 1 })).toBe(0);
    expect(priceSkew(-1, { ...base, targetPrice: 1 })).toBe(0);
  });

  it("is positive below target and negative above it", () => {
    expect(priceSkew(0.9, { ...base, targetPrice: 1 })).toBeGreaterThan(0);
    expect(priceSkew(1.1, { ...base, targetPrice: 1 })).toBeLessThan(0);
  });

  it("is symmetric: an x% discount and an x% premium pull equally hard", () => {
    // The log ratio is what buys this. A plain (target-price)/price ratio
    // saturates at -100% below target while running unbounded above it,
    // which would make the bot defend a floor far more weakly than a ceiling.
    const below = priceSkew(1 / 1.25, { ...base, targetPrice: 1 });
    const above = priceSkew(1.25, { ...base, targetPrice: 1 });
    expect(below).toBeCloseTo(-above, 12);
  });

  it("scales linearly with strength", () => {
    const a = priceSkew(0.9, { ...base, targetPrice: 1 });
    const b = priceSkew(0.9, {
      ...base,
      targetPrice: 1,
      targetPriceStrength: 20,
    });
    expect(b).toBeCloseTo(2 * a, 12);
  });

  it("moves P(buy) by roughly 0.1 per 1% gap at strength 10", () => {
    expect(priceSkew(0.99, { ...base, targetPrice: 1 })).toBeCloseTo(0.1, 2);
  });

  it("does not shrink as the market moves away — the point of the defense", () => {
    // The weekly anchor re-bases to today's open, so a sell-off erases its
    // signal. An absolute target does the opposite: the further the price
    // falls, the harder the skew pushes back.
    const near = priceSkew(0.98, { ...base, targetPrice: 1 });
    const far = priceSkew(0.7, { ...base, targetPrice: 1 });
    expect(far).toBeGreaterThan(near);
  });
});

describe("buyProbability", () => {
  it("is delta-neutral with no target and no anchor bias", () => {
    expect(buyProbability(1, { ...base, targetPrice: 0 })).toBeCloseTo(0.5, 12);
  });

  it("saturates at pBuyMax on a deep discount rather than going one-sided", () => {
    const p = buyProbability(0.5, { ...base, targetPrice: 1 });
    expect(p).toBe(0.85);
  });

  it("saturates at pBuyMin on a deep premium", () => {
    expect(buyProbability(2, { ...base, targetPrice: 1 })).toBe(0.15);
  });

  it("honours custom bounds, including fully deterministic ones", () => {
    const p = buyProbability(0.5, {
      ...base,
      targetPrice: 1,
      pBuyMin: 0,
      pBuyMax: 1,
    });
    expect(p).toBe(1);
  });

  it("adds the anchor bias to the defense skew", () => {
    const withoutBias = buyProbability(1, { ...base, targetPrice: 1 });
    const withBias = buyProbability(1, { ...base, targetPrice: 1 }, 0.2);
    expect(withoutBias).toBeCloseTo(0.5, 12);
    expect(withBias).toBeCloseTo(0.7, 12);
  });

  it("lets the defense override a contrary anchor bias when the gap is wide", () => {
    // Anchor says sell (the token has been drifting down), target says the
    // price is 10% under the floor. The defense must win, or a sell-off
    // never gets defended.
    const p = buyProbability(0.9, { ...base, targetPrice: 1 }, -0.25);
    expect(p).toBeGreaterThan(0.5);
  });

  it("clamps the combined signal, not just the skew", () => {
    const p = buyProbability(0.99, { ...base, targetPrice: 1 }, 0.3);
    expect(p).toBe(0.85);
  });
});

describe("targetDeviation", () => {
  it("is positive when the price sits below the target", () => {
    expect(targetDeviation(0.8, { ...base, targetPrice: 1 })).toBeCloseTo(
      0.25,
      12
    );
  });

  it("is negative when the price sits above the target", () => {
    expect(targetDeviation(1.25, { ...base, targetPrice: 1 })).toBeCloseTo(
      -0.2,
      12
    );
  });

  it("is zero when the defense is disabled", () => {
    expect(targetDeviation(1, { ...base, targetPrice: 0 })).toBe(0);
  });
});

describe("validatePriceDefenseParams", () => {
  it("accepts an empty patch", () => {
    expect(() => validatePriceDefenseParams({})).not.toThrow();
  });

  it("accepts a well-formed patch", () => {
    expect(() =>
      validatePriceDefenseParams({
        targetPrice: 0.0025,
        targetPriceStrength: 10,
        targetPriceReachedTolerancePct: 1,
        pBuyMin: 0.15,
        pBuyMax: 0.85,
      })
    ).not.toThrow();
  });

  it("rejects a negative target price", () => {
    expect(() => validatePriceDefenseParams({ targetPrice: -1 })).toThrow(
      /targetPrice/
    );
  });

  it("rejects a non-finite target price", () => {
    expect(() => validatePriceDefenseParams({ targetPrice: NaN })).toThrow(
      /targetPrice/
    );
  });

  it("rejects a negative strength", () => {
    expect(() =>
      validatePriceDefenseParams({ targetPriceStrength: -5 })
    ).toThrow(/targetPriceStrength/);
  });

  it("rejects an inverted pBuy range", () => {
    expect(() =>
      validatePriceDefenseParams({ pBuyMin: 0.9, pBuyMax: 0.1 })
    ).toThrow(/pBuyMin/);
  });

  it("rejects pBuy bounds outside [0, 1]", () => {
    expect(() => validatePriceDefenseParams({ pBuyMax: 1.5 })).toThrow(
      /pBuyMin/
    );
  });

  it("rejects a one-sided patch that would invert the range", () => {
    // pBuyMin alone is checked against the implicit upper bound, so a
    // patch touching only one side still cannot produce pBuyMin >= pBuyMax.
    expect(() => validatePriceDefenseParams({ pBuyMin: -0.2 })).toThrow(
      /pBuyMin/
    );
  });
});
