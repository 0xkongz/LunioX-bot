import * as fs from "fs";
import * as path from "path";
import { TokenConfig } from "../config";
import { TokenValidationError } from "./errors";
import { logger } from "../utils/logger";

/**
 * On-disk shape of the token registry. Versioned so we can migrate later.
 */
interface RegistryFile {
  version: 1;
  tokens: TokenConfig[];
}

/**
 * Persistent token registry backed by a JSON file.
 *
 * Replaces the hardcoded EZFIN/SRIA/AIRA literal in the original bot. The
 * dashboard adds and removes tokens via the API, and the engine reads the
 * registry on boot + whenever a CRUD operation completes.
 *
 * Persistence model:
 *   - A single JSON file at AppConfig.tokensFile (default: /data/tokens.json
 *     for Railway volumes; ./data/tokens.json locally).
 *   - Writes are atomic: write to .tmp, fs.renameSync into place. This is
 *     the same pattern the existing tracker uses, and survives mid-write
 *     crashes on standard filesystems.
 *   - Reads are eager on construction; the in-memory map is the source of
 *     truth thereafter.
 *   - Keys are uppercased token symbols. We dedupe both by key and by
 *     contract address, so a token can't be added twice under different
 *     keys.
 */
export class TokenRegistry {
  private filePath: string;
  private tokens: Map<string, TokenConfig> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ensureDir();
    this.loadFromDisk();
  }

  // ─── Disk I/O ───────────────────────────────────────────────────────

  private ensureDir(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err: any) {
      logger.error(
        `Failed to create registry dir ${path.dirname(this.filePath)}: ${err.message}`
      );
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      logger.info(
        `[Registry] No tokens file at ${this.filePath} — starting empty`
      );
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as RegistryFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tokens)) {
        logger.warn(
          `[Registry] ${this.filePath} has unexpected shape; ignoring`
        );
        return;
      }
      for (const raw of parsed.tokens) {
        const migrated = this.migrate(raw);
        if (!this.isValidToken(migrated)) {
          logger.warn(
            `[Registry] Skipping malformed token entry: ${JSON.stringify(raw)}`
          );
          continue;
        }
        this.tokens.set(migrated.key.toUpperCase(), migrated);
      }
      logger.info(
        `[Registry] Loaded ${this.tokens.size} token(s) from ${this.filePath}`
      );
    } catch (err: any) {
      logger.error(
        `[Registry] Failed to parse ${this.filePath}: ${err.message}`
      );
    }
  }

  /** Atomically persist current state. */
  private saveToDisk(): void {
    const data: RegistryFile = {
      version: 1,
      tokens: Array.from(this.tokens.values()),
    };
    const tmp = this.filePath + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
      logger.debug(`[Registry] Saved ${data.tokens.length} token(s)`);
    } catch (err: any) {
      logger.error(`[Registry] Save failed: ${err.message}`);
      throw err;
    }
  }

  private isValidToken(t: any): t is TokenConfig {
    if (
      typeof t !== "object" ||
      t === null ||
      typeof t.key !== "string" ||
      typeof t.name !== "string" ||
      typeof t.address !== "string" ||
      typeof t.decimals !== "number" ||
      typeof t.pairToken !== "string" ||
      typeof t.pairDecimals !== "number" ||
      typeof t.pairAddress !== "string" ||
      typeof t.enabled !== "boolean" ||
      !Array.isArray(t.walletIndices)
    ) {
      return false;
    }
    if (t.route !== "direct" && t.route !== "wbnb-hop") return false;
    if (t.route === "wbnb-hop" && typeof t.wbnbUsdtPair !== "string") {
      return false;
    }
    return true;
  }

  /**
   * Migrate legacy entries that pre-date the route field. Older registry
   * files (written before WBNB-hop support was added) only know about
   * direct USDT pairs, so we set route="direct" by default. Anything new
   * goes through the detector and arrives with route already populated.
   */
  private migrate(raw: any): any {
    if (!raw || typeof raw !== "object") return raw;
    if (typeof raw.route === "string") return raw; // Already on the new schema.
    return { ...raw, route: "direct" };
  }

  // ─── Read API ───────────────────────────────────────────────────────

  /** All tokens, in insertion order. */
  list(): TokenConfig[] {
    return Array.from(this.tokens.values());
  }

  /** Map keyed by uppercase symbol — useful for the engine. */
  asMap(): Record<string, TokenConfig> {
    const out: Record<string, TokenConfig> = {};
    for (const [k, v] of this.tokens) out[k] = v;
    return out;
  }

  get(key: string): TokenConfig | undefined {
    return this.tokens.get(key.toUpperCase());
  }

  has(key: string): boolean {
    return this.tokens.has(key.toUpperCase());
  }

  /** Find by address, case-insensitive. Used to dedupe on add. */
  findByAddress(address: string): TokenConfig | undefined {
    const a = address.toLowerCase();
    for (const t of this.tokens.values()) {
      if (t.address.toLowerCase() === a) return t;
    }
    return undefined;
  }

  // ─── Write API ──────────────────────────────────────────────────────

  /**
   * Add a fully-validated token to the registry. Throws TokenValidationError
   * if the key or address already exists; the caller (API handler) should
   * surface the message back to the dashboard.
   */
  add(token: TokenConfig): TokenConfig {
    const key = token.key.toUpperCase();
    if (this.tokens.has(key)) {
      throw new TokenValidationError(
        `Token "${key}" already exists. Remove it first or pick a different key.`
      );
    }
    const dupAddr = this.findByAddress(token.address);
    if (dupAddr) {
      throw new TokenValidationError(
        `Address ${token.address} already registered as "${dupAddr.key}".`
      );
    }
    const stored: TokenConfig = { ...token, key };
    this.tokens.set(key, stored);
    this.saveToDisk();
    logger.info(`[Registry] Added ${key} (${stored.address})`);
    return stored;
  }

  /**
   * Remove by key. Returns true if a token was removed.
   */
  remove(key: string): boolean {
    const k = key.toUpperCase();
    const existed = this.tokens.delete(k);
    if (existed) {
      this.saveToDisk();
      logger.info(`[Registry] Removed ${k}`);
    }
    return existed;
  }

  /**
   * Patch a subset of fields on an existing token. Only fields the operator
   * is allowed to edit are accepted; address/key/pairAddress/pairToken
   * cannot change post-registration (changing them would invalidate the
   * tracker history and require new approvals on-chain).
   */
  update(
    key: string,
    patch: Partial<
      Pick<TokenConfig, "name" | "enabled" | "walletIndices" | "decimals">
    >
  ): TokenConfig {
    const k = key.toUpperCase();
    const existing = this.tokens.get(k);
    if (!existing) {
      throw new TokenValidationError(`Unknown token "${k}"`);
    }
    const updated: TokenConfig = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.walletIndices !== undefined
        ? { walletIndices: [...patch.walletIndices] }
        : {}),
      ...(patch.decimals !== undefined ? { decimals: patch.decimals } : {}),
    };
    this.tokens.set(k, updated);
    this.saveToDisk();
    logger.info(`[Registry] Updated ${k}: ${JSON.stringify(patch)}`);
    return updated;
  }
}
