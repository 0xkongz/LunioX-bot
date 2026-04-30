import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TokenRegistry } from "../services/token-registry";
import { TokenValidationError } from "../services/errors";
import { TokenConfig } from "../config";

function makeToken(overrides: Partial<TokenConfig> = {}): TokenConfig {
  return {
    key: "ABC",
    name: "Token ABC",
    address: "0x" + "11".repeat(20),
    decimals: 18,
    pairToken: "0x55d398326f99059fF775485246999027B3197955",
    pairDecimals: 18,
    pairAddress: "0x" + "22".repeat(20),
    route: "direct",
    enabled: true,
    walletIndices: [0, 1],
    ...overrides,
  };
}

describe("TokenRegistry", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luniox-registry-"));
    filePath = path.join(tmpDir, "tokens.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts empty when no file exists", () => {
    const r = new TokenRegistry(filePath);
    expect(r.list()).toEqual([]);
  });

  it("persists added tokens to disk", () => {
    const r = new TokenRegistry(filePath);
    r.add(makeToken());
    expect(fs.existsSync(filePath)).toBe(true);
    const r2 = new TokenRegistry(filePath);
    expect(r2.list()).toHaveLength(1);
    expect(r2.get("ABC")?.name).toBe("Token ABC");
  });

  it("normalizes keys to uppercase", () => {
    const r = new TokenRegistry(filePath);
    r.add(makeToken({ key: "abc" }));
    expect(r.has("ABC")).toBe(true);
    expect(r.has("abc")).toBe(true);
    expect(r.get("aBc")?.key).toBe("ABC");
  });

  it("rejects duplicate keys", () => {
    const r = new TokenRegistry(filePath);
    r.add(makeToken());
    expect(() => r.add(makeToken({ name: "Different" }))).toThrow(
      TokenValidationError
    );
  });

  it("rejects duplicate addresses under different keys", () => {
    const r = new TokenRegistry(filePath);
    r.add(makeToken({ key: "AAA" }));
    expect(() =>
      r.add(makeToken({ key: "BBB" }))
    ).toThrow(/already registered as "AAA"/);
  });

  it("update() patches mutable fields", () => {
    const r = new TokenRegistry(filePath);
    r.add(makeToken());
    const updated = r.update("ABC", { enabled: false, name: "Renamed" });
    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe("Renamed");
    expect(updated.address).toBe(makeToken().address);
  });

  it("update() throws on unknown key", () => {
    const r = new TokenRegistry(filePath);
    expect(() => r.update("NOPE", { enabled: true })).toThrow(
      TokenValidationError
    );
  });

  it("remove() returns false for unknown key", () => {
    const r = new TokenRegistry(filePath);
    expect(r.remove("NOPE")).toBe(false);
  });

  it("remove() persists removal to disk", () => {
    const r = new TokenRegistry(filePath);
    r.add(makeToken());
    expect(r.remove("ABC")).toBe(true);
    const r2 = new TokenRegistry(filePath);
    expect(r2.list()).toEqual([]);
  });

  it("ignores malformed entries on load", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        tokens: [makeToken(), { key: "BAD" /* missing fields */ }],
      })
    );
    const r = new TokenRegistry(filePath);
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0].key).toBe("ABC");
  });

  it("ignores files with unexpected version", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 99, tokens: [makeToken()] })
    );
    const r = new TokenRegistry(filePath);
    expect(r.list()).toEqual([]);
  });

  it("findByAddress is case-insensitive", () => {
    const r = new TokenRegistry(filePath);
    r.add(makeToken());
    expect(r.findByAddress("0x" + "11".repeat(20))?.key).toBe("ABC");
    expect(r.findByAddress(("0x" + "11".repeat(20)).toUpperCase())?.key).toBe(
      "ABC"
    );
  });

  it("migrates legacy entries without route field to route='direct'", () => {
    // Simulate a tokens.json written before WBNB-hop support landed.
    const legacy = {
      version: 1,
      tokens: [
        {
          key: "OLD",
          name: "Old Token",
          address: "0x" + "33".repeat(20),
          decimals: 18,
          pairToken: "0x55d398326f99059fF775485246999027B3197955",
          pairDecimals: 18,
          pairAddress: "0x" + "44".repeat(20),
          enabled: true,
          walletIndices: [0],
          // NOTE: no `route` field — pre-migration shape
        },
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy));
    const r = new TokenRegistry(filePath);
    expect(r.list()).toHaveLength(1);
    expect(r.get("OLD")?.route).toBe("direct");
  });

  it("accepts wbnb-hop tokens with wbnbUsdtPair", () => {
    const r = new TokenRegistry(filePath);
    const hop = makeToken({
      key: "HOP",
      address: "0x" + "55".repeat(20),
      route: "wbnb-hop",
      wbnbUsdtPair: "0x" + "66".repeat(20),
    });
    r.add(hop);
    const reloaded = new TokenRegistry(filePath).get("HOP");
    expect(reloaded?.route).toBe("wbnb-hop");
    expect(reloaded?.wbnbUsdtPair).toBe("0x" + "66".repeat(20));
  });

  it("rejects wbnb-hop entries on disk that lack wbnbUsdtPair", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        tokens: [
          {
            ...makeToken(),
            route: "wbnb-hop",
            // wbnbUsdtPair intentionally missing — schema violation
          },
        ],
      })
    );
    const r = new TokenRegistry(filePath);
    expect(r.list()).toEqual([]); // Silently skipped as malformed.
  });
});
