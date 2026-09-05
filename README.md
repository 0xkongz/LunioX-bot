# LunioX Trading Bot

Single-runtime, multi-wallet trading bot for BSC tokens on **PancakeSwap V2**.
Tokens are not hardcoded — they are added/removed live from the dashboard
UI by pasting a contract address. Backed by a JSON registry that lives on a
Railway-attached volume so the token list survives redeploys.

This bot is a sibling of `Token X/trading-bot` (which targets PancakeSwap
V4 Infinity CL). The two are independent processes; deploy this one as
its own Railway service.

## What's different from the V4 bot

| Concern             | Token X bot (V4)                      | LunioX bot (this)              |
|---------------------|---------------------------------------|--------------------------------|
| DEX                 | PancakeSwap V4 Infinity CL            | PancakeSwap V2                 |
| Token list source   | Hardcoded EZFIN/SRIA/AIRA in config   | `tokens.json` on disk          |
| Add a token         | Edit env + `EZFIN_POOL_FEE` etc., redeploy | Paste address into UI       |
| Pool key            | `(c0, c1, hooks, mgr, fee, params)`   | V2 pair address                |
| Swap call           | UniversalRouter `INFI_SWAP`           | V2 Router `swapExactTokensForTokensSupportingFeeOnTransferTokens` |
| Pool detection      | n/a (manual fee + tickSpacing)        | `factory.getPair(token, USDT)` |

Strategies (delta-neutral, DCA buy, DCA sell), wallet management, and
the daily tracker are functionally identical.

## Architecture

```
src/
├── index.ts                  Entry point
├── config/index.ts           Env loading; no token literals
├── services/
│   ├── token-registry.ts     JSON-backed token CRUD (atomic writes)
│   ├── token-detector.ts     ERC20 metadata + V2 pair lookup
│   ├── swap.ts               V2 router swap with slippage + dry-run
│   ├── price-feed.ts         V2 pair getReserves() → USD price
│   └── errors.ts             Typed errors surfaced to the UI
├── core/
│   ├── engine.ts             Orchestrator; runtime add/remove tokens
│   ├── wallet-manager.ts     Wallet groups, round-robin selection
│   ├── tracker.ts            Per-day buy/sell volume + net position
│   └── health.ts             V2 pair liveness probe
├── strategies/               Trading logic (mode-pluggable)
├── dashboard/
│   ├── server.ts             Express boot + auth
│   ├── api.ts                /api/tokens CRUD + /status + /mode + /params
│   └── public/index.html     SPA — token dropdown, add modal, per-token cards
└── __tests__/                vitest unit tests
```

## Setup

### Prereqs
- Node 20+
- A funded BSC wallet (or several) with BNB for gas and the pair tokens
  you want to trade
- The contract address of the token to register (must already have a
  PancakeSwap V2 / USDT pair)

### Local development

```bash
npm install
cp .env.example .env       # then edit values
npm run dev                # tsx watch
# Dashboard: http://localhost:3000  (use DASHBOARD_API_KEY to log in)
```

### Build + production

```bash
npm run build
npm start
```

### Tests

```bash
npm test
```

## Adding a token (the new flow)

1. Open the dashboard.
2. Click **+ Add Token**.
3. Paste the BSC contract address.
4. Click **Detect** — the bot calls the ERC20 metadata methods and the
   PancakeSwap V2 factory to confirm the (token, USDT) pair exists. You
   see name/symbol/decimals/pair/liquidity before saving.
5. Adjust the display name and wallet selector if you want, choose
   whether to enable on save, and click **Save**.

The token persists to `TOKENS_FILE`. On the next process boot the bot
loads the registry, so the token survives redeploys.

To remove: select the token in the dropdown and click **Remove**. To
toggle trading without removing: click **Enable / Disable**.

## Configuration

Required:
- `WALLET_PRIVATE_KEYS` — comma-separated `0x…` keys.

Important defaults:
- `PANCAKE_V2_ROUTER` = `0x10ED43C718714eb63d5aA57B78B54704E256024E`
- `PANCAKE_V2_FACTORY` = `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73`
- `TOKENS_FILE` = `/data/tokens.json` (set this to a Railway volume path)
- `TRACKER_DATA_DIR` = `/data/tracker`

See `.env.example` for the full list with defaults.

## Price defense (delta_neutral mode)

Delta-neutral mode combines two direction signals. They answer different
questions and neither substitutes for the other.

**The weekly anchor** asks *where has this token been drifting?* Every
morning at 00:00 UTC it rolls a fresh daily target 1–5% from today's open,
pulled gently toward Monday's anchor. This produces natural-looking tape,
but it cannot hold a level: because it re-bases to today's open, a
sustained sell-off simply drags the target down with it. Set a target 5%
above a price that fell 20% overnight and the bot is still, correctly by
its own logic, aiming below where the token started.

**The price defense** asks *where should this token be?* — from a level you
fix. It contributes an additive skew of `strength × log(target / price)` to
the buy probability. The gap does not shrink because the market moved, so
the buy pressure persists for exactly as long as the discount does. This is
the mechanism the SPRK and SYMETRAX bots use to hold a price.

With a target set, the anchor becomes texture on top of a floor rather than
the thing steering direction: the daily drift roll re-centres on the
defended price, and the intra-day bias is added to the defense skew before
the result is clamped to `[BUY_PROB_MIN, BUY_PROB_MAX]`.

Leave `TARGET_PRICE` at `0` and none of this engages — the bot behaves
exactly as it did before.

### Setting it up

Per token, from the dashboard param grid (or via env for new-token
defaults):

| Setting | What it does |
| --- | --- |
| `Target Price` | The level to defend. `0` disables. |
| `Target Price Unit` | `USD per token` or `Tokens per USD` — whichever is easier to type. |
| `Defense Strength` | Multiplier on the log gap. At 10, a 1% gap moves P(buy) by ~0.1; a 10% gap saturates. |
| `Defense Mode` | `Hold the level` defends indefinitely. `Reach then stop` stands down on arrival. |
| `Reach Tolerance (%)` | Band that counts as arriving, in reach mode. |
| `Max Deviation (%)` | Confirmation threshold for a target far from the live price. |
| `P(buy) Min` / `P(buy) Max` | Clamp on the combined signal. |

The **Price Defense** panel on each token card shows the target, the live
price, the current gap and the resulting P(buy). If P(buy) sits near 0.50
while the gap is wide, the defense is not doing anything — check that the
mode is `delta_neutral` and that reach mode has not already stood down.

### Two things worth knowing

**Reach mode is persisted.** Once the price touches the target, the arrival
is written to the anchor file, so a redeploy does not resume pushing a
target that was already met. Changing the target price or its unit re-arms
the defense automatically; the panel's *Re-arm Defense* button does it
without changing the number.

Arrival counts either when the price lands inside the tolerance band or
when it crosses the target outright — a thin pool can gap straight over a
1% band in a single trade, and without the crossing check the bot would
keep buying a price that already overshot.

**The deviation guard catches unit mix-ups.** `USD_PER_TOKEN` and
`TOKEN_PER_USD` differ by orders of magnitude for a sub-cent token, and a
mis-picked unit does not look wrong on the form — it looks wrong only after
the bot has spent a day buying toward a target it can never reach. Applying
a target further than `Max Deviation (%)` from the live price returns HTTP
409 and asks for confirmation first. Set it to `0` to disable.

## Railway deployment

The whole point of `TOKENS_FILE` is that you can deploy this image, add
tokens via the dashboard, redeploy with a new image, and the tokens are
still there. Without a persistent volume, they aren't — the container
filesystem is wiped on every redeploy.

### Steps

1. **Create the Railway service** from this repo. Railway picks up
   `Dockerfile` and `railway.json` automatically.
2. **Attach a persistent volume**:
   - In the service's **Settings → Volumes**, click **Attach volume**.
   - Mount path: `/data`
   - Size: 1 GB is plenty (the registry is a few KB; the tracker is ~100 KB/day).
3. **Set environment variables** in **Variables**:
   - `WALLET_PRIVATE_KEYS` = your comma-separated keys
   - `DASHBOARD_API_KEY` = a random ≥16-char string (the bot refuses to
     boot in production with the default)
   - `NODE_ENV=production`
   - `TOKENS_FILE=/data/tokens.json` (matches the volume mount)
   - `TRACKER_DATA_DIR=/data/tracker`
   - Optional: `BSC_RPC_URL` to override the default public RPC
4. **Deploy** — Railway builds the Dockerfile and starts the service.
   The first boot will see no `tokens.json` and start with an empty
   registry; add your first token via the dashboard.
5. **Verify the volume** by adding a token, redeploying, and confirming
   it's still there.

### CORS in production

If you serve the dashboard from a different origin than the API, set
`CORS_ORIGIN` to a comma-separated allowlist. By default in production,
CORS is **closed** (no origin allowed) — only same-origin requests work.

## Security notes

- The dashboard is protected by `DASHBOARD_API_KEY`. Use a random
  string ≥16 characters; the server refuses to boot in production
  otherwise.
- Private keys live only in the env var; they're never logged. The
  `/api/wallet` endpoint that accepts a private key over the wire is
  disabled by default (set `ALLOW_RUNTIME_WALLET_ADDITION=true` only if
  you really need it).
- Token registration only validates the ERC20 + V2 pair *exists*. It
  does not vouch for the token's contract code — the operator should
  read BSCScan source before enabling a token.
- Slippage and gas-price guards prevent the bot from trading into bad
  conditions, but they don't replace operator judgment.

## Routing, price impact, and approvals

### Direct vs WBNB hop

When you register a token, the detector first checks
`factory.getPair(token, USDT)`. If that exists, the token gets
`route = "direct"` and trades use a single-hop path `[token, USDT]`.
If no direct USDT pair exists, the detector falls back to
`factory.getPair(token, WBNB)` and verifies the canonical WBNB/USDT
pair is also live; if both are present the token gets
`route = "wbnb-hop"` and trades use `[token, WBNB, USDT]`. The route is
displayed as a badge on each token card.

Direct is always preferred when both exist (one fee, one slippage event,
cheaper gas). The detector only falls back when direct genuinely doesn't
exist.

### Price impact guard

Every trade computes its on-curve constant-product impact before
signing. For a single hop:

```
impact = amountIn / (reserveIn + amountIn)
```

For wbnb-hop swaps the bot chains both hops multiplicatively. If the
result exceeds `maxPriceImpactBps` (per-token, default 1000 bps = 10%),
the swap is aborted before approval and gas costs. You can tune this
live from the dashboard — useful for thin pools where you want to allow
larger impact deliberately.

The actual impact is logged on every trade and shown in the Recent
Trades table (green < 2%, yellow < 5%, red ≥ 5%).

### Allowance cache

The bot caches the most recent on-chain `allowance()` reading per
(wallet, token) for 5 minutes. Repeat trades skip the RPC unless the
cached headroom is insufficient. After an `approve(MaxUint256)` call
the cache is set to "unlimited" for the TTL window. Set
`ALLOW_RUNTIME_WALLET_ADDITION=true` is unrelated — that controls the
runtime wallet-add API, not allowances.

### Fee-on-transfer

The bot uses `swapExactTokensForTokensSupportingFeeOnTransferTokens` so
tokens that charge transfer tax are supported. For non-fee tokens this
is functionally equivalent to `swapExactTokensForTokens`.

## Open questions / known limits

- **V2 only**. V3 and V4 routing would need parallel swap services.
  The registry already separates `route` from `pairAddress`, so a
  future `route = "v3-direct"` would be additive.
- **Single intermediate token (WBNB)**. If a token has neither a USDT
  nor a WBNB pair (e.g. routes only via BUSD or a project-specific
  stable), registration is rejected. Adding a third hop is mechanical —
  extend `TokenRoute` and update `buildPath`/`buildPairPath`.
