import { describe, it, expect, vi } from "vitest";
import { Interface, JsonRpcProvider } from "ethers";
import { connect } from "../services/provider";
import { aggregate3, MULTICALL3_ADDRESS } from "../services/multicall";
import { WalletManager } from "../core/wallet-manager";

// Every read ethers v6 performs is preceded by a network check, and without a
// pinned network that check is an `eth_chainId` request — so the process pays
// two requests for every one it meant to make. These tests observe the raw
// JSON-RPC methods a provider actually emits, because that is the thing being
// billed; asserting on the provider's options would not catch a regression in
// what it puts on the wire.

type Payload = { id: number; method: string; params: any[] };

/**
 * Record every JSON-RPC payload a provider puts on the wire.
 *
 * Stubbed at `_send`, not `send`: ethers' own network detection bypasses
 * `send` and calls `_send` directly, so a `send` spy would miss the very
 * `eth_chainId` traffic these tests exist to measure.
 */
function recordingProvider(
  make: () => JsonRpcProvider,
  answer: (p: Payload) => unknown
): { provider: JsonRpcProvider; sent: Payload[] } {
  const provider = make();
  const sent: Payload[] = [];
  vi.spyOn(provider as any, "_send").mockImplementation(async (payload: any) => {
    const batch: Payload[] = Array.isArray(payload) ? payload : [payload];
    sent.push(...batch);
    return batch.map((p) => ({ id: p.id, result: answer(p) }));
  });
  return { provider, sent };
}

const methodsOf = (sent: Payload[]) => sent.map((p) => p.method);

describe("provider network pinning", () => {
  const ADDRESSES = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003",
  ];
  const answerReads = (p: Payload) => (p.method === "eth_chainId" ? "0x38" : "0x1");

  it("stops re-asking the node for the chain id on every read", async () => {
    const { provider, sent } = recordingProvider(
      () => connect("http://rpc.test", 56),
      answerReads
    );

    for (const a of ADDRESSES) await provider.getBalance(a);

    expect(methodsOf(sent).filter((m) => m === "eth_getBalance")).toHaveLength(3);
    expect(methodsOf(sent)).not.toContain("eth_chainId");
  });

  it("is the fix for a real doubling, not a no-op", async () => {
    // The same three reads on an UNPINNED provider — the shape this replaced.
    // Passing the chain id to the constructor does not stop the re-checking;
    // only staticNetwork does. If this ever stops failing to contain
    // eth_chainId, the pin has become unnecessary and can go.
    const { provider, sent } = recordingProvider(
      () => new JsonRpcProvider("http://rpc.test", 56),
      answerReads
    );

    for (const a of ADDRESSES) await provider.getBalance(a);

    expect(methodsOf(sent)).toContain("eth_chainId");
    expect(sent.length).toBeGreaterThan(3);
  });
});

describe("aggregate3", () => {
  const iface = new Interface([
    "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)",
  ]);

  function multicallProvider(perCall: Array<[boolean, string]>) {
    const calls: string[] = [];
    const { provider, sent } = recordingProvider(
      () => connect("http://rpc.test", 56),
      (p) => {
        if (p.method !== "eth_call") throw new Error(`unexpected method: ${p.method}`);
        const decoded = iface.decodeFunctionData("aggregate3", p.params[0].data);
        calls.push(...decoded[0].map((c: any) => c.target));
        return iface.encodeFunctionResult("aggregate3", [
          decoded[0].map((_c: any, i: number) => perCall[i] ?? [true, "0x"]),
        ]);
      }
    );
    return { provider, sent, calls };
  }

  it("sends N reads as ONE eth_call", async () => {
    const { provider, sent } = multicallProvider([]);
    const target = "0x0000000000000000000000000000000000000009";

    const results = await aggregate3(
      provider,
      Array.from({ length: 12 }, () => ({ target, callData: "0x1234" }))
    );

    expect(results).toHaveLength(12);
    expect(methodsOf(sent).filter((m) => m === "eth_call")).toHaveLength(1);
  });

  it("reports a reverting leg without failing the rest of the batch", async () => {
    const { provider } = multicallProvider([
      [true, "0xaa"],
      [false, "0x"],
      [true, "0xcc"],
    ]);
    const target = "0x0000000000000000000000000000000000000009";

    const results = await aggregate3(
      provider,
      Array.from({ length: 3 }, () => ({ target, callData: "0x1234" }))
    );

    expect(results.map((r) => r.success)).toEqual([true, false, true]);
    expect(results[2].returnData).toBe("0xcc");
  });

  it("makes no request at all for an empty batch", async () => {
    const { provider, sent } = multicallProvider([]);
    expect(await aggregate3(provider, [])).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

describe("WalletManager.refreshBalances", () => {
  // Deterministic throwaway keys — never funded, never used off a test.
  const KEYS = [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000000000000000000000000000003",
  ];

  const balanceIface = new Interface([
    "function getEthBalance(address addr) external view returns (uint256)",
  ]);
  const aggIface = new Interface([
    "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)",
  ]);

  function managerWith(reply: (index: number) => [boolean, string]) {
    const targets: string[] = [];
    const { provider, sent } = recordingProvider(
      () => connect("http://rpc.test", 56),
      (p) => {
        if (p.method !== "eth_call") throw new Error(`unexpected method: ${p.method}`);
        const decoded = aggIface.decodeFunctionData("aggregate3", p.params[0].data);
        targets.push(...decoded[0].map((c: any) => c.target));
        return aggIface.encodeFunctionResult("aggregate3", [
          decoded[0].map((_c: any, i: number) => reply(i)),
        ]);
      }
    );
    return { manager: new WalletManager(KEYS, provider), provider, sent, targets };
  }

  const ok = (wei: bigint): [boolean, string] => [
    true,
    balanceIface.encodeFunctionResult("getEthBalance", [wei]),
  ];

  it("reads the whole fleet in one request through Multicall3", async () => {
    const { manager, sent, targets } = managerWith((i) => ok(BigInt(i + 1)));

    await manager.refreshBalances();

    expect(methodsOf(sent)).toEqual(["eth_call"]);
    expect(targets).toEqual([MULTICALL3_ADDRESS, MULTICALL3_ADDRESS, MULTICALL3_ADDRESS]);
    expect(manager.getAll().map((w) => w.bnbBalance)).toEqual([1n, 2n, 3n]);
  });

  it("keeps a wallet's previous balance when its leg reverts", async () => {
    let revert = false;
    const { manager } = managerWith((i) =>
      revert && i === 1 ? [false, "0x"] : ok(revert ? 99n : BigInt(i + 1))
    );

    await manager.refreshBalances();
    expect(manager.getAll().map((w) => w.bnbBalance)).toEqual([1n, 2n, 3n]);

    revert = true;
    await manager.refreshBalances();
    expect(manager.getAll().map((w) => w.bnbBalance)).toEqual([99n, 2n, 99n]);
  });

  it("makes no request when no wallets are configured", async () => {
    const { provider, sent } = recordingProvider(
      () => connect("http://rpc.test", 56),
      () => "0x"
    );
    await new WalletManager([], provider).refreshBalances();
    expect(sent).toHaveLength(0);
  });
});
