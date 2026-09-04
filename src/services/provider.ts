import { JsonRpcProvider, Network } from "ethers";

/**
 * Provider construction, and the one option on it that dominates this bot's
 * RPC bill.
 *
 * ## Why `staticNetwork`
 *
 * Every read ethers v6 performs — `getBalance`, `call`, `estimateGas`,
 * `getTransactionCount`, `getBlockNumber`, `getTransactionReceipt`, and every
 * `Contract` method behind them — is wrapped in a network check before its
 * result is handed back. That check calls `_detectNetwork()`, and without
 * `staticNetwork` `_detectNetwork()` is an `eth_chainId` request to the node.
 *
 * Passing the chain id as the constructor's second argument does NOT stop
 * this: it tells ethers what to *expect*, and ethers then verifies that
 * expectation against the node on every single operation. So the process pays
 * two billable requests for every one it meant to make, forever, to re-learn a
 * number that cannot change.
 *
 * `staticNetwork` says the connected chain is fixed, and ethers answers
 * `_detectNetwork()` from memory. Nothing else about the provider changes.
 *
 * ## What that costs in safety, and how it is paid back
 *
 * The per-request check was also, incidentally, the thing that would notice an
 * RPC_URL pointed at the wrong chain. Silently trading against the wrong chain
 * is far worse than the requests were expensive, so `connect()` replaces the
 * per-request check with ONE boot-time probe: a provider with no pinned
 * network asks the endpoint what it is, and a mismatch aborts before any
 * wallet is loaded. Verified once at boot rather than re-verified forever.
 */
export function connect(rpcUrl: string, chainId: number): JsonRpcProvider {
  const network = Network.from(chainId);
  return new JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
}

/**
 * Boot-time guard for the pin above: ask the endpoint which chain it actually
 * serves and refuse to start on a mismatch.
 *
 * Deliberately built on its own throwaway provider with NO network argument
 * and NO `staticNetwork` — a provider that has been told the answer cannot be
 * used to check the answer.
 */
export async function assertChainId(
  rpcUrl: string,
  expectedChainId: number
): Promise<void> {
  const probe = new JsonRpcProvider(rpcUrl);
  try {
    const actual = await probe.getNetwork();
    if (Number(actual.chainId) !== expectedChainId) {
      throw new Error(
        `RPC_URL serves chain ${actual.chainId}, but CHAIN_ID is ${expectedChainId}. ` +
          `Refusing to start rather than trade against the wrong chain.`
      );
    }
  } finally {
    probe.destroy();
  }
}
