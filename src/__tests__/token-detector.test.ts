import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenDetector } from "../services/token-detector";
import { TokenValidationError } from "../services/errors";

// We test only the synchronous validation paths here — the network-bound
// happy path (real RPC + real token + real V2 pair) is an integration
// concern. The detector exposes a single async detect() method, but the
// address-shape checks fire before any RPC, so we can drive them with a
// dummy provider and observe the thrown TokenValidationError.

function makeDetector() {
  const fakeProvider = {} as any;
  const config: any = {
    v2FactoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    usdtAddress: "0x55d398326f99059fF775485246999027B3197955",
  };
  return new TokenDetector(config, fakeProvider);
}

describe("TokenDetector address validation", () => {
  let detector: TokenDetector;
  beforeEach(() => {
    detector = makeDetector();
  });

  it("rejects an empty string", async () => {
    await expect(detector.detect("")).rejects.toBeInstanceOf(
      TokenValidationError
    );
  });

  it("rejects a non-hex string", async () => {
    await expect(detector.detect("not-an-address")).rejects.toBeInstanceOf(
      TokenValidationError
    );
  });

  it("rejects a too-short address", async () => {
    await expect(detector.detect("0x123")).rejects.toBeInstanceOf(
      TokenValidationError
    );
  });

  it("rejects USDT itself (would be circular)", async () => {
    const usdt = "0x55d398326f99059fF775485246999027B3197955";
    await expect(detector.detect(usdt)).rejects.toThrow(/USDT/i);
  });

  it("rejects a malformed checksum address", async () => {
    // Mixed-case but with a wrong checksum char — ethers.getAddress flags it.
    const bad = "0xAaaaAAAaaaAaaAAAAaAAaaAAAAAAAAAAAaaaaaab";
    await expect(detector.detect(bad)).rejects.toBeInstanceOf(
      TokenValidationError
    );
  });

  it("trims whitespace before validating", async () => {
    // All-zero address → format passes, but normalization runs without
    // throwing on shape; we'll see the call go on to RPC. For a unit
    // test we just verify it doesn't reject at the syntax stage.
    const padded = "  0x" + "0".repeat(40) + "  ";
    // The call will hit the provider mock and throw something other
    // than the address-shape error.
    await expect(detector.detect(padded)).rejects.not.toThrow(
      /not a valid 0x-prefixed/
    );
  });
});
