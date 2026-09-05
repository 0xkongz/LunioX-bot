import { TradingParams } from "../config";

/**
 * Absolute target-price defense — the mechanism SPRK and SYMETRAX use to
 * hold a price level, ported here for LunioX's delta-neutral mode.
 *
 * The weekly anchor answers "where has this token been drifting?" and
 * re-bases to today's open every morning. That makes for natural-looking
 * tape, but it cannot defend anything: a sustained sell-off simply drags
 * the drift target down with it, and the bot happily follows the price
 * into the floor.
 *
 * This module answers a different question — "where should the price be?"
 * — from a level the operator fixes. The gap to that level does not shrink
 * just because the market moved, so the buy pressure persists for as long
 * as the discount does. Both signals are combined in DeltaNeutralStrategy:
 * the anchor supplies the texture, the target supplies the floor.
 *
 * Every function here is pure, so the direction logic is testable without
 * an RPC, a wallet, or a clock.
 */

/**
 * Normalise the configured target to USD per whole token, matching the
 * convention `PriceFeed.priceUsd` uses.
 *
 * Returns 0 when the defense is disabled, which every caller below treats
 * as "no skew" — so a token with no target set behaves exactly as it did
 * before this module existed.
 */
export function targetPriceUsd(params: Partial<TradingParams>): number {
  const target = params.targetPrice ?? 0;
  if (!Number.isFinite(target) || target <= 0) return 0;
  return params.targetPriceUnit === "TOKEN_PER_USD" ? 1 / target : target;
}

/**
 * Additive P(buy) skew toward the target price.
 *
 * The log ratio is deliberate: a price x% *below* the target produces the
 * same magnitude of buy pressure as x% *above* produces sell pressure. A
 * plain (target - price) / price ratio is asymmetric — it saturates at
 * -100% on the downside while running unbounded on the upside, which is
 * exactly backwards for defending a floor.
 *
 * `targetPriceStrength` scales the result: at 10, a 1% gap shifts P(buy)
 * by about 0.1, and a 10% gap saturates against the pBuy clamp. The clamp
 * in buyProbability() is what actually bounds this, so a large gap cannot
 * turn the bot fully one-directional unless the operator sets the bounds
 * to 0 and 1 on purpose.
 */
export function priceSkew(
  priceUsd: number,
  params: Partial<TradingParams>
): number {
  const target = targetPriceUsd(params);
  if (!target || !(priceUsd > 0)) return 0;
  return (params.targetPriceStrength ?? 0) * Math.log(target / priceUsd);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Probability of buying on the next trade.
 *
 * Starts delta-neutral at 0.5, adds the absolute target-price skew and
 * whatever bias the weekly anchor contributes, then clamps to
 * [pBuyMin, pBuyMax] so there is always organic two-way flow. A bot that
 * only ever buys is trivially readable on-chain and invites being farmed;
 * the clamp keeps roughly 15% of trades on the counter side by default.
 */
export function buyProbability(
  priceUsd: number,
  params: Partial<TradingParams>,
  anchorBias = 0
): number {
  const lo = params.pBuyMin ?? 0.15;
  const hi = params.pBuyMax ?? 0.85;
  return clamp(0.5 + priceSkew(priceUsd, params) + anchorBias, lo, hi);
}

/**
 * Signed deviation of the live price from the target, as a fraction:
 * positive means the price sits *below* target (the bot needs to push up),
 * negative means above. Returns 0 when the defense is disabled.
 */
export function targetDeviation(
  priceUsd: number,
  params: Partial<TradingParams>
): number {
  const target = targetPriceUsd(params);
  if (!target || !(priceUsd > 0)) return 0;
  return target / priceUsd - 1;
}
