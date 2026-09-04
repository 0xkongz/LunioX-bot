import { Contract, Provider } from "ethers";

/**
 * Multicall3 — deployed at the same address on every chain this bot targets,
 * BSC included. Used here for the one thing ethers cannot batch on its own:
 * turning N independent reads into a single `eth_call`.
 */
export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * `aggregate3` returns `(bool success, bytes returnData)[]`, so one reverting
 * leg does not take the whole batch down with it. `getEthBalance` is a plain
 * view method on the same contract — the only way to fold a NATIVE balance
 * into a call batch, since `eth_getBalance` is its own JSON-RPC method and can
 * never ride along with contract reads.
 */
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)",
  "function getEthBalance(address addr) external view returns (uint256)",
  "function getBlockNumber() external view returns (uint256)",
];

export interface Call {
  /** Contract to call. */
  target: string;
  /** Encoded calldata for that contract. */
  callData: string;
}

export interface CallResult {
  success: boolean;
  returnData: string;
}

/**
 * Chunk size for one `aggregate3`. Each leg here is a short read (a balance, a
 * reserves tuple), so the ceiling that matters is the node's `eth_call` gas
 * cap, not calldata size — 100 legs is comfortably under it while keeping a
 * realistic fleet inside a SINGLE request.
 */
const MAX_CALLS_PER_REQUEST = 100;

/** Build a Multicall3 handle bound to `provider`. */
export function multicall3(provider: Provider): Contract {
  return new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
}

/**
 * Run `calls` through `aggregate3`, in as few requests as the chunk size
 * allows. Every leg is `allowFailure: true`, so a reverting read comes back as
 * `success: false` for the caller to interpret rather than rejecting the batch
 * — the same posture as reading each one independently and catching.
 */
export async function aggregate3(
  provider: Provider,
  calls: Call[]
): Promise<CallResult[]> {
  if (calls.length === 0) return [];

  const mc = multicall3(provider);
  const out: CallResult[] = [];

  for (let i = 0; i < calls.length; i += MAX_CALLS_PER_REQUEST) {
    const chunk = calls.slice(i, i + MAX_CALLS_PER_REQUEST);
    // `staticCall`, not a plain invocation: `aggregate3` is declared payable, so
    // calling it directly would have ethers build and BROADCAST a transaction.
    // We want the read — an `eth_call` — which is the whole point of batching here.
    const results = (await mc.aggregate3!.staticCall(
      chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))
    )) as Array<[boolean, string]>;
    for (const [success, returnData] of results) out.push({ success, returnData });
  }

  return out;
}
