/**
 * Thrown when a price lookup returns zero or negative (RPC blip, pool
 * drained, etc.). Callers that compute a *sell* amount from USD must catch
 * this — the previous silent fallback returned a stablecoin-decimals amount
 * that sent the wrong number of tokens to the router.
 */
export class PriceUnavailableError extends Error {
  constructor(tokenName: string) {
    super(`Price unavailable for ${tokenName}; cannot compute sell amount`);
    this.name = "PriceUnavailableError";
  }
}

/**
 * Thrown by TokenRegistry / TokenDetector when the operator-supplied input
 * is invalid (bad address, contract is not ERC20, no V2 pair against USDT,
 * duplicate registry entry). Surfaced to the dashboard so the operator gets
 * an actionable message.
 */
export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenValidationError";
  }
}
