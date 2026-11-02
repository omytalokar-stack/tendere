# Paper Trading Backend

Node.js/Express paper-trading service using MongoDB Atlas and Binance public Spot market data. It does not submit orders to Binance and requires no exchange credentials.

## Run locally

1. Use Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` and a private `BOT_CONTROL_TOKEN`.
3. Run `npm install`, `npm test`, and `npm start`.

The service initializes one wallet with `INITIAL_BALANCE_USDT` (default 10,000 USDT), bootstraps exactly 500 unique, contiguous, completed Binance candles per symbol sequentially from `BINANCE_REST_URL` (default `https://data-api.binance.vision`) with a 2-second gap between symbols, then receives candle closes, trade ticks, and top-20 depth through one combined WebSocket (`BINANCE_WS_URL`, default `wss://data-stream.binance.vision/stream`). Set `BINANCE_REST_BOOTSTRAP_ENABLED=false` to start directly in WebSocket-only accumulation mode. The REST host rejects Binance trading API hostnames. No REST depth polling occurs. If REST bootstrap returns HTTP 418 or an IP-ban response, the service stops all further REST requests for the process lifetime, logs that it is accumulating candles from the live WebSocket stream, and leaves trading frozen until each symbol has exactly 500 contiguous closed candles and a fresh depth quote. A recent trade tick is preferred for displayed prices; when a symbol has no recent trade, its price is the midpoint of the fresh Binance best bid and ask. Both trade and depth prices are real exchange data. REST requests are serialized with a minimum 150ms gap. The scanner calculates indicators only from verified closed candles; no market data is generated locally.

Paper entries and exits use a fresh Binance Spot depth quote (best ask for buys, best bid for sells) with a 0.075% adverse execution adjustment per fill. Existing positions are monitored against real Binance kline highs/lows and remain open when a fresh execution quote is unavailable. This service is paper-only and does not send exchange orders.

## Browser notifications and uptime checks

Enable browser trade alerts from the dashboard header. The frontend requests notification permission and registers a service worker, then detects trade entry, exit, and losing-stop cooldown changes through its three-second backend polling. Notifications can appear while the page is open or backgrounded, subject to browser throttling; they are not delivered after the browser/page is closed. True closed-browser Web Push requires a push subscription and a server-side push service, which this application does not configure.

Configure an external uptime monitor to request `GET /api/health/live`. This lightweight endpoint returns HTTP 200 with `{ "status": "ok", "timestamp": "..." }` without querying MongoDB or Binance. It can help keep a Render instance warm but does not replace an always-on Render plan for continuous trading.

## Trading defaults

- Symbols: ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, ADAUSDT, AVAXUSDT.
- On each aligned completed candle close, the scanner checks all six symbols and allows only one open account position. Entries require at least 7 aligned votes from 10 real closed-candle indicators, current closed-candle volume greater than 1.5x the prior 20-candle average, and at least 60% matching top-20 Binance book pressure.
- Stop distance is 1.5 ATR; take-profit defaults to a 2:1 reward/risk ratio.
- Quantity is calculated directly as `(wallet balance * 0.02) / absolute(entry price - stop price)`. Entries are skipped if their required margin plus entry fee exceeds available margin. Leverage defaults to 1x.
- Each fill includes a 0.075% taker fee as well as the existing adverse execution adjustment. Entry fees reduce available margin immediately; realized wallet P&L is gross P&L minus both entry and exit fees.
- If stop-loss and take-profit are both touched within one candle, the stop-loss is assumed to fill first. Opposing qualified momentum signals can close a position early. A daily realized-loss limit pauses new entries; existing positions continue to be monitored.
- A net-losing stop-loss records the closed-candle indicator/volume snapshot and applies a three-candle symbol cooldown (45 minutes on the default 15-minute interval). A unique partial MongoDB index enforces one open position account-wide. Wallet reservations and trade opens/closes use MongoDB transactions, so use an Atlas replica set (Atlas clusters support this).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health/live` | Liveness probe |
| GET | `/api/health/ready` | MongoDB readiness probe |
| GET | `/api/bot/status` | Runtime state, configured symbols, latest prices |
| GET | `/api/bot/audit` | Recent in-memory engine, trade, and feed events |
| GET | `/api/wallet` | Paper wallet and margin balances |
| GET | `/api/trades?status=OPEN&limit=50` | Recent paper trades (OPEN/CLOSED, 1–200) |
| GET | `/api/market/status` | Verified live prices, 500 closed candles, L2 depth, and indicators; returns 503 when any symbol's real feed is unavailable |
| GET | `/api/market/:symbol/candles` | Exactly 500 completed Binance candles |
| GET | `/api/market/:symbol/indicators` | Indicators computed from completed Binance candles and live order book |
| GET | `/api/market/:symbol/orderbook` | Top 20 levels from the Binance depth stream |
| GET | `/api/market/prices` | Verified Binance prices; returns 503 when live market data is unavailable |
| POST | `/api/bot/start` | Start scanning; Bearer token required |
| POST | `/api/bot/stop` | Pause new entries while continuing to monitor/close open positions; Bearer token required |
| POST | `/api/trades/:id/close` | Close an open paper trade at latest price; Bearer token required |

Set `BOT_CONTROL_TOKEN` on the backend and send `Authorization: Bearer <token>` for every control request. Keep this token on a trusted server; never embed it in browser-delivered Vercel code. Configure `ALLOWED_ORIGINS` as a comma-separated list. `*.vercel.app` and local development origins are also allowed.

## Render deployment

Create a Node web service rooted at `trading-bot-backend`, build command `npm install`, start command `npm start`, and set the environment variables above in Render. Use an always-on Render instance for continuous scanning; a sleeping instance cannot process candles. MongoDB data persists in Atlas. Binance public market-data outages reconnect automatically with exponential backoff; inspect service logs and `/api/health/ready` for failures.
