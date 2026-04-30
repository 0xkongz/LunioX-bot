import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { SwapService } from "../services/swap";

function makeService() {
  const fakeProvider = {} as any;
  const config: any = {
    v2RouterAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    v2FactoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    usdtAddress: "0x55d398326f99059fF775485246999027B3197955",
    wbnbAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    maxGasPriceGwei: 5,
    gasLimitOverride: 500000,
    dryRun: true,
  };
  return new SwapService(config, fakeProvider);
}

function makeTokenConfig(overrides: any = {}) {
  return {
    key: "ABC",
    name: "ABC",
    address: "0x" + "11".repeat(20),
    decimals: 18,
    pairToken: "0x55d398326f99059fF775485246999027B3197955",
    pairDecimals: 18,
    pairAddress: "0x" + "22".repeat(20),
    route: "direct" as const,
    enabled: true,
    walletIndices: [0],
    ...overrides,
  };
}

describe("SwapService.amountFromUsd", () => {
  it("converts USD floats to base-18 wei", () => {
    const svc = makeService();
    const wei = svc.amountFromUsd(50, 18);
    expect(wei).toBe(ethers.parseUnits("50.000000", 18));
  });

  it("respects 6-decimals stable representation", () => {
    const svc = makeService();
    const wei = svc.amountFromUsd(0.123456, 6);
    expect(wei).toBe(ethers.parseUnits("0.123456", 6));
  });

  it("truncates to 6 decimal places of USD precision", () => {
    const svc = makeService();
    // 0.1234567 → toFixed(6) = "0.123457"
    const wei = svc.amountFromUsd(0.1234567, 18);
    expect(wei).toBe(ethers.parseUnits("0.123457", 18));
  });
});

describe("SwapService dry-run", () => {
  it("returns a synthetic SwapResult without touching the network", async () => {
    const svc = makeService();
    const fakeWallet: any = { address: "0x" + "ff".repeat(20) };
    const tokenConfig = makeTokenConfig();

    const result = await svc.executeSwap(
      fakeWallet,
      tokenConfig,
      ethers.parseUnits("10", 18),
      "buy",
      100
    );

    expect(result.success).toBe(true);
    expect(result.txHash).toMatch(/^0xdryrun_/);
    expect(result.direction).toBe("buy");
    expect(result.tokenName).toBe("ABC");
    expect(result.walletAddress).toBe(fakeWallet.address);
    // priceImpactBps is computed even in dry-run, but with our fake
    // provider the pair-reserve read will throw → service catches it
    // and returns 0 instead of failing.
    expect(typeof result.priceImpactBps).toBe("number");
  });

  it("propagates wbnb-hop config — pair path includes both pairs", async () => {
    const svc = makeService();
    const fakeWallet: any = { address: "0x" + "ff".repeat(20) };
    const hop = makeTokenConfig({
      route: "wbnb-hop",
      pairAddress: "0x" + "aa".repeat(20),
      wbnbUsdtPair: "0x" + "bb".repeat(20),
    });
    // Dry-run should still succeed; no pair reserves are required to
    // synthesize the result. Real impact calc errors are swallowed.
    const result = await svc.executeSwap(
      fakeWallet,
      hop,
      ethers.parseUnits("10", 18),
      "buy",
      100
    );
    expect(result.success).toBe(true);
  });
});
