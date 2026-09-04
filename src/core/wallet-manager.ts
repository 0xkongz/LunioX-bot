import { ethers, Wallet, JsonRpcProvider, Interface } from "ethers";
import { aggregate3, MULTICALL3_ADDRESS } from "../services/multicall";
import { logger } from "../utils/logger";

export interface WalletInfo {
  index: number;
  address: string;
  wallet: Wallet;
  bnbBalance: bigint;
  label: string;
}

/**
 * A scoped view of wallets assigned to a specific token.
 * Provides round-robin and random selection within the assigned subset.
 */
export class TokenWalletGroup {
  private wallets: WalletInfo[];
  private roundRobinIndex = 0;
  readonly tokenKey: string;

  constructor(tokenKey: string, wallets: WalletInfo[]) {
    this.tokenKey = tokenKey;
    this.wallets = wallets;
    logger.info(
      `[${tokenKey}] Assigned wallets: ${wallets.map((w) => w.label).join(", ") || "none"}`
    );
  }

  /** Get all wallets in this group */
  getAll(): WalletInfo[] {
    return this.wallets;
  }

  /** Get wallet count for this token */
  count(): number {
    return this.wallets.length;
  }

  /** Get a specific wallet by its global index */
  get(globalIndex: number): WalletInfo {
    const w = this.wallets.find((w) => w.index === globalIndex);
    if (!w) throw new Error(`Wallet index ${globalIndex} not assigned to ${this.tokenKey}`);
    return w;
  }

  /** Get a wallet by position within this group (0-based) */
  getByPosition(position: number): WalletInfo {
    if (position < 0 || position >= this.wallets.length) {
      throw new Error(`Position ${position} out of range for ${this.tokenKey} (has ${this.wallets.length} wallets)`);
    }
    return this.wallets[position];
  }

  /** Pick next wallet in round-robin order within this group */
  nextRoundRobin(): WalletInfo {
    if (this.wallets.length === 0) throw new Error(`No wallets assigned to ${this.tokenKey}`);
    const w = this.wallets[this.roundRobinIndex % this.wallets.length];
    this.roundRobinIndex++;
    return w;
  }

  /** Pick a random wallet within this group */
  random(): WalletInfo {
    if (this.wallets.length === 0) throw new Error(`No wallets assigned to ${this.tokenKey}`);
    return this.wallets[Math.floor(Math.random() * this.wallets.length)];
  }

  /** Pick a random wallet different from the given address, within this group */
  randomExcluding(excludeAddress: string): WalletInfo | null {
    const candidates = this.wallets.filter(
      (w) => w.address.toLowerCase() !== excludeAddress.toLowerCase()
    );
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Add a wallet to this group (used when adding wallets at runtime) */
  addWallet(wallet: WalletInfo): void {
    if (!this.wallets.find((w) => w.index === wallet.index)) {
      this.wallets.push(wallet);
    }
  }

  /** Get global indices of wallets in this group */
  getIndices(): number[] {
    return this.wallets.map((w) => w.index);
  }

  /** Get summary for dashboard */
  getSummary(): Array<{ label: string; address: string; bnbBalance: string; globalIndex: number }> {
    return this.wallets.map((w) => ({
      label: w.label,
      address: w.address,
      bnbBalance: ethers.formatEther(w.bnbBalance),
      globalIndex: w.index,
    }));
  }
}

export class WalletManager {
  private wallets: WalletInfo[] = [];
  private provider: JsonRpcProvider;
  private tokenGroups: Map<string, TokenWalletGroup> = new Map();

  constructor(privateKeys: string[], provider: JsonRpcProvider) {
    this.provider = provider;

    for (let i = 0; i < privateKeys.length; i++) {
      const wallet = new Wallet(privateKeys[i], provider);
      this.wallets.push({
        index: i,
        address: wallet.address,
        wallet,
        bnbBalance: 0n,
        label: `Wallet-${i + 1}`,
      });
      logger.info(`Loaded wallet ${i + 1}: ${wallet.address}`);
    }
  }

  /**
   * Create or replace a TokenWalletGroup for a token using the specified wallet indices.
   */
  createTokenGroup(tokenKey: string, indices: number[]): TokenWalletGroup {
    const wallets = indices
      .filter((i) => i >= 0 && i < this.wallets.length)
      .map((i) => this.wallets[i]);

    const group = new TokenWalletGroup(tokenKey, wallets);
    this.tokenGroups.set(tokenKey, group);
    return group;
  }

  /** Remove a token's wallet group (used on token deregistration). */
  removeTokenGroup(tokenKey: string): void {
    this.tokenGroups.delete(tokenKey);
  }

  /** Get the wallet group for a token */
  getTokenGroup(tokenKey: string): TokenWalletGroup {
    const group = this.tokenGroups.get(tokenKey);
    if (!group) throw new Error(`No wallet group for token: ${tokenKey}`);
    return group;
  }

  hasTokenGroup(tokenKey: string): boolean {
    return this.tokenGroups.has(tokenKey);
  }

  /**
   * Refresh BNB balances for all wallets in ONE request.
   *
   * `eth_getBalance` is its own JSON-RPC method, so N wallets meant N billable
   * requests every refresh no matter how they were issued — `Promise.all` made
   * them concurrent, not fewer. Multicall3's `getEthBalance` is a contract
   * read, so the whole fleet fits in a single `eth_call`.
   *
   * A wallet whose leg fails keeps its previous value: stale but true beats a
   * zero an operator would read as "this wallet needs funding".
   */
  async refreshBalances(): Promise<void> {
    if (this.wallets.length === 0) return;

    const iface = new Interface([
      "function getEthBalance(address addr) external view returns (uint256)",
    ]);
    const results = await aggregate3(
      this.provider,
      this.wallets.map((w) => ({
        target: MULTICALL3_ADDRESS,
        callData: iface.encodeFunctionData("getEthBalance", [w.address]),
      }))
    );

    for (let i = 0; i < this.wallets.length; i++) {
      const result = results[i];
      if (!result?.success) {
        logger.warn(
          `BNB balance read failed for wallet ${i + 1} (${this.wallets[i].address}); keeping the previous value`
        );
        continue;
      }
      const [balance] = iface.decodeFunctionResult("getEthBalance", result.returnData);
      this.wallets[i].bnbBalance = balance as bigint;
    }
  }

  /** Get all wallets */
  getAll(): WalletInfo[] {
    return this.wallets;
  }

  /** Get wallet count */
  count(): number {
    return this.wallets.length;
  }

  /** Get a specific wallet by index */
  get(index: number): WalletInfo {
    if (index < 0 || index >= this.wallets.length) {
      throw new Error(`Wallet index ${index} out of range`);
    }
    return this.wallets[index];
  }

  /** Add a new wallet at runtime, optionally assign to token groups */
  addWallet(privateKey: string, tokenKeys?: string[]): WalletInfo {
    const wallet = new Wallet(privateKey, this.provider);
    const info: WalletInfo = {
      index: this.wallets.length,
      address: wallet.address,
      wallet,
      bnbBalance: 0n,
      label: `Wallet-${this.wallets.length + 1}`,
    };
    this.wallets.push(info);
    logger.info(`Added new wallet ${info.label}: ${info.address}`);

    if (tokenKeys) {
      for (const tk of tokenKeys) {
        const group = this.tokenGroups.get(tk);
        if (group) group.addWallet(info);
      }
    }

    return info;
  }

  /** Get summary for dashboard — includes which tokens each wallet serves */
  getSummary(): Array<{
    label: string;
    address: string;
    bnbBalance: string;
    globalIndex: number;
    tokens: string[];
  }> {
    return this.wallets.map((w) => {
      const tokens: string[] = [];
      for (const [tokenKey, group] of this.tokenGroups) {
        if (group.getIndices().includes(w.index)) {
          tokens.push(tokenKey);
        }
      }
      return {
        label: w.label,
        address: w.address,
        bnbBalance: ethers.formatEther(w.bnbBalance),
        globalIndex: w.index,
        tokens,
      };
    });
  }
}
