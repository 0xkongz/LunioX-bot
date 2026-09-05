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

/**
 * Thrown when a target price is set further from the live price than
 * `targetPriceMaxDeviationPct` allows. Deliberately recoverable: the
 * operator can re-submit with `force` once they have confirmed the number
 * is what they meant.
 *
 * The guard exists because the two quote conventions differ by orders of
 * magnitude for a sub-cent token. Fat-fingering the unit turns the defense
 * into an unbounded one-sided buy — this is the cheapest place to catch it.
 */
export class TargetPriceGuardError extends Error {
  readonly livePrice: number;
  readonly targetPrice: number;
  readonly deviationPct: number;
  readonly maxDeviationPct: number;

  constructor(opts: {
    livePrice: number;
    targetPrice: number;
    deviationPct: number;
    maxDeviationPct: number;
  }) {
    super(
      `Target price $${opts.targetPrice} is ${opts.deviationPct.toFixed(1)}% away from ` +
        `the live price $${opts.livePrice} (limit ${opts.maxDeviationPct}%). ` +
        `Check the price unit, then re-apply with force to confirm.`
    );
    this.name = "TargetPriceGuardError";
    this.livePrice = opts.livePrice;
    this.targetPrice = opts.targetPrice;
    this.deviationPct = opts.deviationPct;
    this.maxDeviationPct = opts.maxDeviationPct;
  }
}
