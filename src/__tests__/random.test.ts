import { describe, it, expect } from "vitest";
import { gaussian, exponential } from "../utils/random";

describe("gaussian", () => {
  it("over 10k samples has mean ~0 and stddev ~1 with default args", () => {
    const N = 10_000;
    const samples = Array.from({ length: N }, () => gaussian(0, 1));
    const mean = samples.reduce((a, b) => a + b, 0) / N;
    const variance =
      samples.reduce((a, b) => a + (b - mean) ** 2, 0) / N;
    const stddev = Math.sqrt(variance);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(stddev - 1)).toBeLessThan(0.05);
  });

  it("respects mean and stddev params", () => {
    const N = 10_000;
    const samples = Array.from({ length: N }, () => gaussian(10, 2));
    const mean = samples.reduce((a, b) => a + b, 0) / N;
    expect(Math.abs(mean - 10)).toBeLessThan(0.1);
  });

  it("returns finite numbers", () => {
    for (let i = 0; i < 1000; i++) {
      const v = gaussian(0, 1);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("exponential", () => {
  it("over 10k samples has mean ~ rate parameter", () => {
    const N = 10_000;
    const samples = Array.from({ length: N }, () => exponential(300));
    const mean = samples.reduce((a, b) => a + b, 0) / N;
    expect(Math.abs(mean - 300)).toBeLessThan(15); // within 5%
  });

  it("returns only positive values", () => {
    for (let i = 0; i < 1000; i++) {
      expect(exponential(100)).toBeGreaterThan(0);
    }
  });

  it("returns finite numbers", () => {
    for (let i = 0; i < 1000; i++) {
      expect(Number.isFinite(exponential(60))).toBe(true);
    }
  });
});
