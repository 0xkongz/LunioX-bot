import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, parseWalletSelector } from "../config";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("parseWalletSelector", () => {
  it("returns all indices when empty", () => {
    expect(parseWalletSelector("", 3)).toEqual([0, 1, 2]);
  });

  it("parses range form", () => {
    expect(parseWalletSelector("1-3", 5)).toEqual([0, 1, 2]);
  });

  it("clips range to available wallets", () => {
    expect(parseWalletSelector("1-10", 3)).toEqual([0, 1, 2]);
  });

  it("parses comma-separated form", () => {
    expect(parseWalletSelector("1,3,5", 5)).toEqual([0, 2, 4]);
  });

  it("drops out-of-range indices in comma form", () => {
    expect(parseWalletSelector("1,9", 3)).toEqual([0]);
  });
});

describe("loadConfig", () => {
  beforeEach(() => resetEnv());
  afterEach(() => resetEnv());

  it("throws when WALLET_PRIVATE_KEYS is missing", () => {
    delete process.env.WALLET_PRIVATE_KEYS;
    expect(() => loadConfig()).toThrow(/WALLET_PRIVATE_KEYS/);
  });

  it("throws when no keys after split", () => {
    process.env.WALLET_PRIVATE_KEYS = "  ,  ";
    expect(() => loadConfig()).toThrow(/at least one wallet/i);
  });

  it("uses canonical PCS V2 contracts when no overrides", () => {
    process.env.WALLET_PRIVATE_KEYS = "0xaa";
    const c = loadConfig();
    expect(c.v2RouterAddress).toMatch(/^0x10ED43C7/i);
    expect(c.v2FactoryAddress).toMatch(/^0xcA143Ce/i);
  });

  it("rejects invalid DEFAULT_MODE", () => {
    process.env.WALLET_PRIVATE_KEYS = "0xaa";
    process.env.DEFAULT_MODE = "moonshot";
    expect(() => loadConfig()).toThrow(/Invalid DEFAULT_MODE/);
  });

  it("respects TOKENS_FILE override", () => {
    process.env.WALLET_PRIVATE_KEYS = "0xaa";
    process.env.TOKENS_FILE = "/tmp/custom-tokens.json";
    const c = loadConfig();
    expect(c.tokensFile).toBe("/tmp/custom-tokens.json");
  });

  it("rejects malformed PANCAKE_V2_ROUTER", () => {
    process.env.WALLET_PRIVATE_KEYS = "0xaa";
    process.env.PANCAKE_V2_ROUTER = "not-an-address";
    expect(() => loadConfig()).toThrow(/PANCAKE_V2_ROUTER/);
  });

  it("loads new natural-trading params with sensible defaults", () => {
    process.env.WALLET_PRIVATE_KEYS = "0xaa";
    const c = loadConfig();
    expect(c.defaultTradingParams.dailyDriftMinPct).toBe(1);
    expect(c.defaultTradingParams.dailyDriftMaxPct).toBe(5);
    expect(c.defaultTradingParams.anchorPullStrength).toBe(3);
    expect(c.defaultTradingParams.biasStrength).toBe(5);
    expect(c.defaultTradingParams.tradeSizeSigma).toBe(0.4);
    expect(c.defaultTradingParams.quietPeriodProbability).toBe(0.005);
  });

  it("respects env overrides for natural-trading params", () => {
    process.env.WALLET_PRIVATE_KEYS = "0xaa";
    process.env.DAILY_DRIFT_MIN_PCT = "0.5";
    process.env.DAILY_DRIFT_MAX_PCT = "8";
    process.env.ANCHOR_PULL_STRENGTH = "5";
    process.env.BIAS_STRENGTH = "10";
    process.env.TRADE_SIZE_SIGMA = "0.6";
    process.env.QUIET_PERIOD_PROBABILITY = "0.01";
    const c = loadConfig();
    expect(c.defaultTradingParams.dailyDriftMinPct).toBe(0.5);
    expect(c.defaultTradingParams.dailyDriftMaxPct).toBe(8);
    expect(c.defaultTradingParams.anchorPullStrength).toBe(5);
    expect(c.defaultTradingParams.biasStrength).toBe(10);
    expect(c.defaultTradingParams.tradeSizeSigma).toBe(0.6);
    expect(c.defaultTradingParams.quietPeriodProbability).toBe(0.01);
  });
});
