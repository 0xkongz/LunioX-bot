# LunioX Natural Trading Design

**Date:** 2026-05-05
**Status:** Approved for implementation
**Replaces:** Existing `delta_neutral` strategy behavior

## Summary

The current `delta_neutral` strategy produces a chart that looks visibly bot-driven: step jumps from constant trade sizes hitting a thin pool, persistent slippage drift in one direction, and mechanical timing that's easy to spot in the volume bars. This design rewrites the strategy to produce a more organic-looking chart while preserving the daily volume target.

The new behavior introduces:

1. **Weekly anchor + daily drift** — each Monday at 00:00 UTC the bot snapshots a weekly anchor price; each day rolls a directional drift target of 1–5% biased gently toward the anchor.
2. **Tightened directional bias** — even when actively pushing toward today's target, at least ~25% of trades are counter-direction, mimicking real order flow.
3. **Micro-flow improvements** — gaussian trade sizes (replacing uniform jitter), exponential intervals (replacing uniform jitter), and occasional 30–60 minute quiet periods.

The change is folded into the existing `delta_neutral` mode rather than introducing a new mode. The DCA modes are unaffected.

## Problem statement

The chart from the current bot run shows three visible bot-tells:

- **Step jumps**: each $10 trade moves price ~0.4% on the LunioX/USDT pair (reserves ~$1078 USDT). Constant trade sizes produce identical-magnitude jumps.
- **Persistent upward drift**: nominal "delta neutral" trades drift the price upward over multiple days due to slippage compounding (each round-trip leaves the buyer ahead by the LP fee).
- **Mechanical timing**: uniform interval jitter of ±20% on a 300s base produces evenly-spaced volume bars that anyone scrolling the chart can identify as "bot."

Operator goal:

- Daily price drift bounded to ±1–5%
- Price ideally returns near Monday's open by next Monday (loose target — no forced corrections)
- Daily volume target ~$1000 still hit
- Chart looks like real trader activity, not a script

## Approach selection

Three approaches were considered:

| Approach | Daily drift control | Naturalness | Complexity |
|---|---|---|---|
| **A. Daily target with anchor bias** *(picked)* | Explicit | Good when execution is stochastic | Medium |
| **B. Continuous probabilistic drift** | None — emergent | Maximum | Low |
| **C. Daily directional commitment** | None — emergent | Medium | Low |

**Approach A was selected** because the operator explicitly asked for "1–5% drift per day" — only A delivers controllable per-day magnitude. The naturalness comes from execution (variable trade size, exponential timing, ≥25% counter-direction trades) rather than from leaving direction or magnitude unspecified.

Mean-reversion strictness chosen: **Loose (±5%, no forced correction)**. Bot biases trades toward anchor through a gentle pull mechanism in daily direction selection, but never forces a Sunday landing.

Volume vs naturalness tradeoff chosen: **Even split** — ship medium settings, expose all knobs, tune from the dashboard based on observed chart behavior over the first week.

## Architecture

The change is folded into the existing `delta_neutral` strategy. **No new trading mode is added.** Operators already running `delta_neutral` get the new behavior automatically after deploy.

### Modules added

- `src/services/weekly-anchor.ts` — Loads/saves anchor + today's target state per token. Runs the daily target roll at 00:00 UTC. Runs the Monday anchor reset.
- Tests: `src/__tests__/weekly-anchor.test.ts`

### Modules modified

- `src/strategies/delta-neutral.ts` — `decide()` body rewritten. Net-based direction + amount clamping replaced by target-based direction + gaussian sizing + occasional skip-this-tick.
- `src/strategies/base.ts` — Adds a virtual `nextIntervalMs()` method on `BaseStrategy`. Default returns uniform-jitter interval (preserving DCA behavior); delta-neutral overrides to exponential.
- `src/core/engine.ts` — Calls `weeklyAnchor.tick()` once per minute to handle daily/weekly rolls. Disables the hourly rebalance loop for tokens in `delta_neutral` mode (it would fight the daily drift target). The hourly rebalance is unchanged for other modes.
- `src/utils/random.ts` — Adds `gaussian(mean, stddev)` and `exponential(rate)` helpers.
- `src/config/index.ts` — Adds new `TradingParams` fields: `dailyDriftMinPct`, `dailyDriftMaxPct`, `anchorPullStrength`, `biasStrength`, `tradeSizeSigma`, `quietPeriodProbability`.
- `src/dashboard/api.ts` — Adds `POST /api/tokens/:key/reset-anchor` endpoint.
- `src/dashboard/public/index.html` — Each enabled `delta_neutral` token card renders a new "Weekly Cycle" section + new param inputs.
- `src/core/tracker.ts` — **Unchanged.** Daily volume + net + trades still tracked the same way; the meaning of "net" simply changes from "should be zero" to "is the running consequence of today's drift."

### Tests modified

- `src/__tests__/strategies.test.ts` — One new test for delta-neutral direction selection given a specific (target, current_price) input.
- `src/__tests__/random.test.ts` (new file if missing) — Tests for gaussian and exponential helpers.

## State model

Per token, persisted to `/data/anchor/<TOKEN_KEY>.json`:

```json
{
  "anchor": {
    "price": "0.01703",
    "setAt": "2026-05-04T00:00:00.000Z"
  },
  "today": {
    "open": "0.01703",
    "target": "0.01762",
    "openedAt": "2026-05-05T00:00:00.000Z"
  }
}
```

- `price` and `open` and `target` are stored as strings to preserve exact decimal representation across JSON round-trips.
- Atomic writes: write to `<file>.tmp`, then `fs.renameSync` into place — same pattern as the existing `tracker.ts`.
- File is read once on `WeeklyAnchor` construction, kept in memory thereafter; in-memory copy is the source of truth, disk is the persistence backstop.

Quiet-period state is **in-memory only**:

```ts
private quietUntil: Map<TokenKey, number> = new Map(); // ms timestamp
```

Quiet periods don't persist across restarts — that's an intentional simplification; restarts are rare and the bot resuming early just looks like "trader came back."

## Daily and weekly lifecycle

The lifecycle runs on a **once-per-minute tick** from the engine, not on a precise scheduler. This matches the existing trade interval mechanism and makes the design tolerant to tick latency.

### Weekly anchor reset — Monday 00:00 UTC

Triggered when the current minute crosses into Monday 00:00 UTC and the persisted anchor's `setAt` was before this Monday:

1. Snapshot current price → that's the new `anchor.price`
2. Set `anchor.setAt = now`
3. Persist
4. Continue immediately into the daily roll (which will use the just-set anchor)

### Daily roll — every day 00:00 UTC

Triggered when the current minute crosses into a new UTC day and `today.openedAt` is from a prior day:

1. Snapshot current price → that's `today.open`
2. Compute `d = (today.open − anchor.price) / anchor.price`
3. Direction probability:
   ```
   P(up) = clamp(0.5 − d × pullStrength, 0.1, 0.9)
   ```
   Default `pullStrength = 3`. Behavior at boundary cases:

   | Distance from anchor | P(up) |
   |---|---|
   | 0% | 0.50 |
   | +5% | 0.35 |
   | −5% | 0.65 |
   | +10% | 0.20 (clamp engaged) |

   The 0.1/0.9 clamp ensures real chance of further drift even at the extremes, so the pattern doesn't look mechanically mean-reverting.

4. Roll today's drift magnitude: `magnitude = uniform(dailyDriftMinPct, dailyDriftMaxPct)` (default 1–5%)
5. Roll direction sign: weighted coin against `P(up)`
6. `today.target = today.open × (1 + sign × magnitude / 100)`
7. Persist `today`

### Within-day direction selection

At each trade decision, compute drift-remaining `r = (target − current_price) / current_price`, then:

```
P(buy) = 0.5 + clamp(r × biasStrength, −0.3, +0.3)
```

Default `biasStrength = 5`, clamp `±0.3`. Behavior:

| `r` (drift remaining as fraction) | P(buy) | Buy/sell ratio |
|---|---|---|
| 0% (at target) | 0.50 | 50/50 |
| +1% (need to push up 1%) | 0.55 | 55/45 |
| +3% | 0.65 | 65/35 |
| +5% | 0.75 | 75/25 |
| +6% (clamp engaged) | 0.80 | 80/20 |
| −5% (passed target, pull back down) | 0.25 | 25/75 |

The clamp at ±0.3 guarantees **at least 20% counter-direction trades** even when bot is aggressively pushing toward target — that's what produces the "two steps forward, one step back" pattern of real order flow.

### Edge cases

| Condition | Behavior |
|---|---|
| First run, no anchor file | Snapshot current price as anchor + today.open simultaneously. Roll today's target normally. |
| Bot offline through one or more 00:00 UTC ticks | On boot, if `today.openedAt` is from a prior date, roll fresh target using *current* price as `today.open`. No backfill. |
| Bot restarts mid-day | `today` is valid in JSON — load and continue. No re-roll. |
| Manual anchor reset | Operator hits `POST /api/tokens/:key/reset-anchor`. Confirms via dashboard dialog. Snapshots current price as new anchor + today.open + rolls fresh target. |
| RPC fails during snapshot | Retry 3× with 5s backoff. If all fail, log and skip the daily/weekly roll — try again on next minute's tick. Existing `today` stays valid. |
| Persistence write fails | Log warning. In-memory state still authoritative; next successful write catches up. Atomic write prevents partial state. |

## Micro-flow improvements

Three changes to the existing trade execution that together kill the step-jump and mechanical-timing tells. All three apply only when the strategy is `delta_neutral`. DCA modes retain current behavior.

### Trade size — gaussian instead of uniform

Current: `tradeAmountUsd × uniform(±variancePercent/100)` → trades evenly distributed in a narrow band.

New: `tradeAmountUsd × (1 + gaussian(0, sigma))`, clamped to `[0.5×base, 2×base]`. Default `sigma = 0.4`.

| | Distribution shape |
|---|---|
| ~68% of trades | $6–$14 (within 1σ at base $10) |
| ~95% of trades | $5–$20 (clamped tail) |
| Mean | ~$10 (matches `tradeAmountUsd`) |

Implementation: helper in `src/utils/random.ts`:

```ts
export function gaussian(mean: number, stddev: number): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stddev * z;
}
```

### Timing — exponential intervals (Poisson arrivals)

Current: `intervalSeconds × uniform(0.8, 1.2)` → evenly spaced volume bars.

New: gap follows exponential distribution with mean = `intervalSeconds`, generated as `−intervalSeconds × ln(random())`, clamped to `[30s, 3 × intervalSeconds]`.

| | Distribution shape |
|---|---|
| Mean gap | `intervalSeconds` (e.g., 300s) |
| Variance | High — sometimes 60s clusters, sometimes 700s gaps |
| Min clamp | 30s (avoid sub-second back-to-back swaps) |
| Max clamp | 3 × `intervalSeconds` (avoid 30-min gaps when token should be active) |

Implementation: `BaseStrategy.nextIntervalMs()` virtual method. Default returns the existing uniform-jitter formula. `DeltaNeutralStrategy` overrides to exponential. Engine consumes via `strategy.nextIntervalMs()`.

```ts
// In src/utils/random.ts
export function exponential(mean: number): number {
  return -mean * Math.log(Math.random());
}
```

### Quiet periods

At each tick, with probability `quietPeriodProbability` (default 0.005, ≈ once every ~3 hours of ticks), strategy returns `shouldTrade: false` *and* sets an in-memory `quietUntil` timestamp 30–60 minutes in the future. Subsequent ticks during that window short-circuit at the top of `decide()` with `shouldTrade: false`.

State is in-memory only — restarts clear it.

## Dashboard surface

### Per-token "Weekly Cycle" panel

Visible only when token's mode is `delta_neutral`. Renders between the daily volume bar and the wallets row.

```
┌─────────────────────────────────────────────────┐
│  WEEKLY CYCLE                                   │
│  Anchor    $0.01703   Mon 2026-05-04 00:00 UTC │
│  Today     $0.01703 → $0.01762 (+3.4% target)   │
│  Now       $0.01718   ↑ 0.9% from open          │
│  Progress  ████████░░░░░░░░░░░░  41% to target  │
│                              [↺ Reset Anchor]   │
└─────────────────────────────────────────────────┘
```

- **Anchor** row: `anchor.price` + `anchor.setAt` (rendered as "Mon YYYY-MM-DD HH:MM UTC")
- **Today** row: `today.open` → `today.target`, with computed drift % shown
- **Now** row: live price from the existing `priceFeed`, with delta-from-open computed and arrow-coded (↑ if up, ↓ if down)
- **Progress bar**: `(current − open) / (target − open)`, clipped to [0%, 100%]; visual fill colored same as existing daily volume bar (accent purple)
- **Reset Anchor button**: triggers `POST /api/tokens/:key/reset-anchor` after confirm dialog

### New param inputs

Added to the existing param-group section (only shown for `delta_neutral`):

| Label | Field | Default | Range |
|---|---|---|---|
| Daily Drift Min (%) | `dailyDriftMinPct` | 1 | 0.1–10 |
| Daily Drift Max (%) | `dailyDriftMaxPct` | 5 | 0.1–10 |
| Anchor Pull Strength | `anchorPullStrength` | 3 | 1–10 |
| Direction Bias Strength | `biasStrength` | 5 | 1–15 |
| Trade Size Sigma | `tradeSizeSigma` | 0.4 | 0.1–1.0 |
| Quiet Period Probability | `quietPeriodProbability` | 0.005 | 0.001–0.05 |

All editable live via existing `POST /api/params` flow — no restart required. Strategy reads from `this.params` on each `decide()` call, so changes propagate immediately.

### New API endpoint

`POST /api/tokens/:key/reset-anchor` — operator-triggered manual anchor reset. Snapshots current price as new anchor + today.open + rolls fresh target. Returns `{ success: true, anchor: { price, setAt }, today: { open, target } }`.

## Error handling

| Failure mode | Behavior |
|---|---|
| RPC fails during anchor snapshot | Retry 3× with 5s backoff. If all fail, log error, skip the roll. Stale `today` still valid. |
| RPC fails during Monday weekly snapshot | Same as above. If anchor doesn't update by Monday EOD, log loud warning + continue using last week's anchor. Operator can fix via Reset Anchor button. |
| Persistence write fails | Log warning. Memory state authoritative. Next successful write catches up. |
| Clock drift on Railway | All time math uses `Date.now()` against UTC. Railway containers are NTP-synced; seconds-level skew doesn't affect daily-granularity rolls. |
| Bot booted with no anchor file | First-run path: snapshot current price as anchor + today.open. Single roll. |
| Bot booted mid-day with stale `today` (different date) | Treat as missed-day path — drop stale, roll fresh against current price. |
| Quiet-period state lost on restart | In-memory only by design; restart looks like "trader came back early." |
| `dailyDriftMinPct > dailyDriftMaxPct` (operator misconfig) | Validate on param update; reject with clear error message. |

## Test plan

### New file: `src/__tests__/weekly-anchor.test.ts`

1. **Anchor pull formula** — `P(up)` correct at d=0, d=±0.05, d=±0.10; clamps to 0.1/0.9 work.
2. **Daily target generation** — direction respects pull, magnitude in `[min, max]`, target = open × (1 + signed drift); over 1000 rolls at d=0, direction split is ≈ 50/50.
3. **Direction bias formula** — `P(buy)` correct at r=0, r=±0.025, r=±0.05; clamps to 0.2/0.8 work.
4. **Persistence round-trip** — write anchor + today JSON, read it back, fields match exactly.
5. **First-run path** — no file exists → snapshot current as anchor + today.open + roll target.
6. **Stale-today path** — `openedAt` from yesterday → fresh roll against current price.
7. **Weekly reset path** — Monday tick rolls anchor + today fresh.
8. **Edge clock cases** — same-minute boot doesn't double-roll; midnight UTC crossing handled correctly.

### Modified file: `src/__tests__/strategies.test.ts`

One new test for `delta_neutral` direction selection given a specific `(target, current_price)` input — verify P(buy) ≈ formula over 1000 trials.

### New or modified file: `src/__tests__/random.test.ts`

1. **gaussian** — over 10k samples, mean ≈ 0 (within 0.05), stddev ≈ 1 (within 0.05).
2. **exponential** — mean over 10k samples ≈ rate parameter, no negatives, no NaNs.

Total estimated new tests: ~12 across 1 new file + 2 modified files.

## Out of scope (for this iteration)

- Multi-week patterns (cross-week trends, e.g., "this week up 5%, next week down 5%"). Each week is independent.
- Time-of-day weighting (e.g., more activity during US trading hours, less overnight).
- Weekend special behavior. Same logic applies Mon–Sun.
- Backtesting against historical data. Operator validates by running 1 week and tuning live.
- Cross-token correlation (LunioX moves don't affect any other token's behavior).

## Migration notes

- Existing operators running `delta_neutral` get the new behavior automatically on deploy.
- New `TradingParams` fields default to safe values — no required action from existing operators.
- Anchor file `/data/anchor/<TOKEN>.json` is created on first tick after deploy; no migration needed.
- Hourly rebalance is disabled for `delta_neutral` tokens; remains active for DCA modes.

## Acceptance criteria

After 7 calendar days running with default settings on the LunioX/USDT pair, the chart should:

- Show daily candle ranges between 1–5% (no day with >6% range, no day with <0.5% range)
- Show weekly net price change ≤ ±5% from Monday open
- Show visibly varied trade sizes ($5–$20 range, weighted toward $10) on dexscreener
- Show non-uniform inter-trade intervals (no obvious "every 5 minutes" rhythm)
- Hit daily volume target within ±30% (target is even split, so $700–$1300 from $1000)
- No on-chain failed transactions due to balance issues (existing pre-flight check handles this)
