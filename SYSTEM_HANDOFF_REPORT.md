# AuraAlgo Crypto Paper Trading — System Handoff Report

**Report checked:** 2026-11-02  
**Purpose:** Give a future AI/developer enough context to understand, troubleshoot, and safely change this project.

## 1. What this project is

AuraAlgo is a browser dashboard plus a Node.js paper-trading backend. It reads public Binance Spot market data, calculates indicators from completed candles, and can simulate trades in a MongoDB-backed virtual wallet.

**This is paper trading only.** The application does not connect to a funded broker account, submit Binance orders, or need Binance API keys. A simulated result does not predict or guarantee a real profit.

## 2. Current production state observed

The following is a point-in-time read-only check, not a promise of future uptime:

- Render service: `https://tendere-1.onrender.com`
- Vercel dashboard: `https://auraalgo-crypto-paper-trading.vercel.app`
- `/api/health/live`: HTTP 200
- `/api/health/ready`: HTTP 200; MongoDB connected; backend engine running
- Bot status: running and **entries enabled**
- Binance feed: connected; market data ready
- Markets: ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, ADAUSDT, AVAXUSDT
- Each market returned 500 completed candles and 20 bid + 20 ask levels
- Prices were sourced from the Binance trade stream during the check
- Open paper trades: 0
- Virtual wallet balance observed: about 9,991.67 USDT; available margin was the same; in-trade margin was 0
- Existing realized paper result at that time: approximately -8.33 USDT

The status is stored in MongoDB and can change. Query the live endpoints rather than assuming these values are still current.

## 3. Architecture and data flow

```text
Browser (React/Vite on Vercel)
  ├─ reads /api/* through Vercel rewrites
  └─ sends control actions to the Vercel /api/control serverless gateway
       └─ gateway adds server-side BOT_CONTROL_TOKEN and calls Render

Render (Node.js/Express)
  ├─ MongoDB Atlas: bot state, virtual wallet, paper trades
  ├─ Binance public REST: bootstrap historical klines
  └─ Binance public combined WebSocket: klines, trades, top-20 depth
       └─ strategy + risk checks + paper-only execution simulation
```

### Frontend

- React + TypeScript + Vite; main screen and tabs are in `src/App.tsx`.
- `src/services/backendApi.ts` fetches backend snapshots and validates feed shape: all configured symbols, 500 candles, and 20 levels on each side of the book.
- The dashboard refreshes its backend snapshot and audit events approximately every 3 seconds.
- Tabs: Home, Strategy, Brain Health, Wallet.
- Strategy offers a per-symbol indicator inspector and an in-app candlestick view.
- The chart uses finalized Binance candle data; the candle graphic is rendered by this app.
- Browser notifications are optional and depend on dashboard polling; `public/sw.js` handles notification clicks. The backend separately sends best-effort ntfy.sh alerts for paper-trade opens/closes and daily loss-limit trips, independent of the dashboard being open.
- Home's idle mascot is a black cat with a heartbeat pulse. The animation respects reduced-motion preference.
- `favicon.ico` has previously returned 404; this does not cause market API errors.

### Backend

- Node.js CommonJS + Express + Mongoose; entry point: `trading-bot-backend/src/server.js`.
- The server connects to MongoDB, initializes model indexes and the virtual wallet, restores persisted bot enabled state, starts the market feed, and listens on Render's `PORT`.
- Main logic:
  - `trading-bot-backend/src/services/binanceFeed.js`: historical candle bootstrap, combined Binance WebSocket, feed validation and reconnects.
  - `trading-bot-backend/src/services/strategy.js`: indicator calculations, consensus votes, entry gates and position sizing.
  - `trading-bot-backend/src/services/paperTradingEngine.js`: scanner, paper fills, position lifecycle, fees, wallet accounting and readiness.
  - `trading-bot-backend/src/app.js`: HTTP API, CORS, validation and error responses.
- MongoDB models:
  - `BotState.js`: persistent enabled/paused state.
  - `VirtualWallet.js`: virtual balance, margin and realized P&L.
  - `PaperTrade.js`: open/closed simulated trades and execution/analysis fields.
- The trade schema has unique partial indexes limiting the account to one open position. Wallet/trade opens and closes use MongoDB transactions, so use an Atlas replica set.

## 4. Binance market data and real-data checks

- Configured symbols: ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, ADAUSDT, AVAXUSDT.
- Default candle interval: 15 minutes.
- REST host default: `https://data-api.binance.vision`; trading API hosts are rejected by config.
- WebSocket default: `wss://data-stream.binance.vision/stream`.
- Startup downloads 500 unique, contiguous, completed candles for each symbol, sequentially with a delay between symbols.
- A `418`/IP ban pauses REST bootstrap requests until the supplied expiry/`Retry-After` duration passes; the backend keeps the WebSocket running and retries missing histories with backoff. It reports unavailable markets and blocks paper entries until verified history is available.
- The combined socket receives finalized/in-progress klines, trade events, and Binance partial-depth snapshots.
- Binance's `depth20` payload does not use the same event shape as a diff-depth `depthUpdate`. The parser uses the combined-stream name and the `bids`/`asks` arrays. Regression test: `combined WebSocket partial-depth messages update the order book`.
- Market data is not generated with random/demo prices. The frontend clears its snapshot and displays the error if required data is invalid/unavailable.
- Prices normally use the latest Binance trade. If the trade tick is quiet but the top-of-book is still fresh, backend can provide the midpoint of the real best bid/ask and labels its source as `ORDER_BOOK_MID`.
- Current safety freshness limit is 15 seconds for the market quote/order book. If both usable trade and depth data become stale, the backend must fail closed instead of presenting it as live.
- Closed-candle indicators do not recalculate on every trade tick; they update as the closed-candle stream advances. The UI price can move faster than candle-based indicator votes.

## 5. Strategy and risk model

These are deterministic rules, not human judgment, machine-learning predictions, or a profitability guarantee.

### Ten indicator votes

The backend analyzes verified finalized candles with the `technicalindicators` package and its own VWAP/Supertrend calculations:

1. RSI-14
2. MACD (12, 26, 9)
3. EMA-20 versus EMA-50
4. Price versus EMA-200
5. Supertrend (10, multiplier 3)
6. Bollinger Bands (20, 2 standard deviations; vote uses middle band)
7. ATR-14 (risk measurement; neutral vote)
8. ADX-14 with directional indicators
9. VWAP over the 500-candle history
10. Current closed-candle volume versus the prior 20-candle average, plus close direction

The backend checks finalized candle fields and requires at least 250 candles to calculate; the live feed/dashboard requires exactly 500 contiguous candles.

### Entry gates

A new entry is considered only when:

- The bot's persisted enabled flag is true.
- All six markets are ready and their completed candle closes align.
- There is no open position anywhere in the account.
- The daily realized-loss limit has not been reached.
- The symbol is not in its post-loss cooldown.
- Fresh Binance order-book data is available.
- At least 7 of the 10 votes align for the same direction.
- Current closed-candle volume is strictly greater than 1.5 times the previous 20-candle mean.
- Matching side of top-20 order-book quantity is at least 60%.

The current vote display can show a majority without an entry signal: all gates must pass. If no qualifying setup occurs, the expected behavior is to hold cash.

### Position size and simulated fills

- Default planned risk budget: 2% of current virtual wallet balance per trade.
- Quantity formula: `(wallet balance * 0.02) / abs(entry price - stop price)`.
- Default leverage: 1x; configurable limit is 1x–5x. Leverage changes margin required, not the risk-budget formula.
- Stop distance: 1.5 × ATR.
- Default target: 2 × stop distance (2:1 reward/risk).
- Entry uses best ask for LONG or best bid for SHORT; exit uses best bid for LONG or best ask for SHORT.
- The simulated execution price includes 0.075% adverse slippage per fill and a 0.075% taker fee per fill.
- Entry is skipped if required margin plus entry fee exceeds available margin.
- Planned risk is not a maximum guaranteed loss. Gaps, latency, market changes, fees and simulation assumptions can produce different outcomes.

### Position monitoring and protection

- Stop/target are monitored using Binance kline highs/lows. If both are touched in one candle, stop-loss is treated as first.
- The close is simulated only when a fresh execution book is available; backend does not invent a fill if the quote is stale.
- An opposing qualified momentum signal can close early.
- A net-losing stop applies a 3-candle cooldown (45 minutes at 15m interval) to that symbol and records indicator/volume feedback.
- Daily realized losses aggregate UTC-day closed losing paper trades. Default limit is 400 USDT; it blocks new entries, not monitoring/closing existing positions.
- One open account-wide position is enforced both in scanner logic and by MongoDB unique partial indexes.

## 6. API endpoints

| Method | Route | Meaning |
|---|---|---|
| GET | `/api/health/live` | Lightweight process liveness |
| GET | `/api/health/ready` | MongoDB readiness and engine running state |
| GET | `/api/bot/status` | Running/enabled/feed readiness, prices, risk config and per-symbol errors |
| GET | `/api/bot/audit` | Recent in-memory engine/feed/trade events for this process |
| GET | `/api/market/status` | All six validated live market snapshots; 503 if any required market is unavailable |
| GET | `/api/market/:symbol/candles` | Exactly 500 completed candles for a configured symbol |
| GET | `/api/market/:symbol/indicators` | Calculated indicators and votes |
| GET | `/api/market/:symbol/orderbook` | Fresh Binance top-20 order book |
| GET | `/api/market/prices` | Verified current prices |
| GET | `/api/wallet` | Virtual wallet and margin |
| GET | `/api/trades?status=OPEN\|CLOSED&limit=...` | Paper trade history |
| POST | `/api/bot/start` | Enable new paper entries; backend token required |
| POST | `/api/bot/stop` | Pause new entries; monitoring continues; backend token required |
| POST | `/api/trades/:id/close` | Authorized manual paper close at fresh quote |

Error codes such as `DATA_FEED_OFFLINE`, `INSUFFICIENT_HISTORICAL_DATA`, and `ORDERBOOK_DISCONNECTED` are intentional fail-closed behavior, not proof of a frontend build failure.

## 7. Deployment and environment variables

### Render backend

- Root directory: `trading-bot-backend`
- Build command: `npm install`
- Start command: `npm start`
- Node engine: `>=20`
- `PORT` is assigned by Render.
- Required:
  - `MONGODB_URI`: private Atlas replica-set connection string.
  - `BOT_CONTROL_TOKEN`: private high-entropy token used by control middleware.
- Optional/defaulted by backend:
  - `ALLOWED_ORIGINS`: comma-separated allowed browser origins; `*.vercel.app` and localhost are also allowed in backend CORS.
  - `BOT_ENABLED`: initial default only when no persisted BotState exists.
  - `INITIAL_BALANCE_USDT`: default 10000.
  - `CANDLE_INTERVAL`: default `15m`.
  - `PAPER_LEVERAGE`: default 1, allowed 1–5.
  - `REWARD_RISK_RATIO`: default 2, allowed 1–10.
  - `DAILY_LOSS_LIMIT_USDT`: default 400.
  - `NTFY_TOPIC`: ntfy.sh topic for backend trade/circuit-breaker alerts; defaults to `auraalgo_live_897k3_rajesh`. Use a long random topic and keep it private because anyone who knows it can subscribe or publish.
  - `BINANCE_REST_URL`: default `https://data-api.binance.vision`.
  - `BINANCE_REST_BOOTSTRAP_ENABLED`: default true.
  - `BINANCE_WS_URL`: default `wss://data-stream.binance.vision/stream`.

### Vercel frontend/control gateway

- Root build is the Vite app; `vercel.json` forwards read endpoints to the Render URL.
- Control gateway environment variables:
  - `PAPER_TRADING_API_URL`: Render base URL only, e.g. `https://tendere-1.onrender.com` (no `/api`).
  - `BOT_CONTROL_TOKEN`: same secret as Render; keep it server-side and never prefix with `VITE_`.
  - `CONTROL_DASHBOARD_ORIGIN`: exact production origin, including `https://`, no trailing slash.
- `VITE_API_BASE_URL` is not needed for current production rewrites; frontend defaults to `/api`. If configuring it, do not point at a stale Render hostname.
- The control gateway allows only bot start/stop and a validated paper-trade close path. It checks request method, exact origin, backend URL, and has the token injected server-side.

## 8. Recent fixes and relevant history

- `ae3209b`: update Vercel rewrites to the Render service hostname.
- `e0cc3ca`: parse Binance combined partial-depth payloads correctly; add regression test.
- `0eafaed`: use a fresh Binance book as a valid quote when trade ticks pause; use a labeled L2 midpoint for display, while requiring a fresh bid/ask for simulated execution.
- `14315e5`: replace the center idle radar with a black-cat mascot.
- `5ceb1f7`: change the cat logo animation to heartbeat pulse and remove radar rotation.

## 9. Verification performed

At report creation:

- Backend `npm test`: 30 tests passed.
- Frontend `npm run lint`: passed (`tsc --noEmit`).
- Frontend `npm run build`: passed.
- Live read-only API check: health/readiness 200; bot enabled; 6/6 market snapshots; 500 candles and 20 book levels per symbol.
- A separate cross-check recalculated all 10 votes and numeric indicator values from returned live candles/order books for each of the six symbols; results matched the production API at that time.
- Browser UI was opened on Home, Strategy, Brain Health, and Wallet; Strategy candle chart was also opened.

These checks do not prove uninterrupted future uptime, guaranteed profitability, or that every rendered visual has been tested on every screen size/browser.

## 10. Troubleshooting guide

### Dashboard says Feed offline / API returns 503

1. Check Render `/api/health/live`, `/api/health/ready`, `/api/bot/status`.
2. In `bot/status`, inspect `marketDataReady`, `feedConnected`, and each `marketErrors` entry.
3. Check `/api/market/status` response body for the first unavailable symbol and exact reason.
4. Confirm each symbol has 500 contiguous finalized candles and recent order-book update. A quiet trade stream can be normal; stale trade alone should not override a fresh book in the current backend.
5. Inspect Render logs for REST 418/IP ban, Binance WebSocket disconnect, MongoDB errors, or startup failure. Do not solve feed issues by removing candle/order-book validation.
6. A Vite `__dirname` warning is a build warning; a missing favicon is unrelated to market data.

### Bot is running but no new trade

- `running: true` means the backend process/feed is operating; it does not mean new entries are enabled.
- Check persisted `enabled`, market readiness, aligned 15-minute close, vote count, volume ratio, L2 pressure, account-wide open-position limit, cooldown, wallet margin, and daily loss limit.
- No trade is an expected result when any entry condition fails. Never loosen thresholds merely to force activity without a deliberate, documented risk decision.

### Dashboard start/stop controls fail

- Verify Vercel control-gateway environment variables above and redeploy after changing them.
- Verify Render has the matching `BOT_CONTROL_TOKEN`.
- Verify exact `CONTROL_DASHBOARD_ORIGIN` equals the browser's production origin.
- Vercel deployment protection may require authorized access. Do not expose the token in frontend code or browser bundles.

### New visual/code change not visible

- Confirm Vercel deployed the latest GitHub commit and new JS/CSS bundle hashes are served.
- Hard refresh with Ctrl+F5 after deployment.

## 11. Security and safe handoff rules

- Credentials were pasted into the conversation/editor during troubleshooting. Treat the previously visible MongoDB password and bot control token as compromised: rotate both, update Render/Vercel environment settings, and redeploy. Do not copy their values from chat/history into a report or source file.
- Never inspect, print, commit, or share `.env` values. Keep `.env` files private.
- Keep secrets out of `VITE_*` variables, client bundles, screenshots, logs and support messages.
- Existing unrelated local changes may be present in `.gitignore` and `.aistudio/`. Preserve them; do not reset or overwrite them while addressing another task.
- Read-only troubleshooting should not start/stop the bot, close trades, edit wallet state, or submit real exchange orders unless the user specifically requests the state-changing action.
- Never change this paper-only system into real-money trading without a separately scoped design, authorization, security review, risk controls, and explicit user approval.
- Describe the system as rule-based paper simulation. Do not claim it thinks like a human or can guarantee profit.
