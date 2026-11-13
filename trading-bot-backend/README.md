# Paper Trading Backend

Node.js/Express paper-trading service using MongoDB Atlas and Binance public Spot market data. It does not submit orders to Binance and requires no exchange credentials.

## Run locally

1. Use Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` and a private `BOT_CONTROL_TOKEN`.
3. Run `npm install`, `npm test`, and `npm start`.

The service initializes one wallet with `INITIAL_BALANCE_USDT` (default 10,000 USDT), bootstraps exactly 500 unique, contiguous, completed Binance candles per symbol sequentially from `BINANCE_REST_URL` (default `https://data-api.binance.vision`) with a 2-second gap between symbols, then receives candle closes, trade ticks, and top-20 depth through one combined WebSocket (`BINANCE_WS_URL`, default `wss://data-stream.binance.vision/stream`). Set `BINANCE_REST_BOOTSTRAP_ENABLED=false` to start directly in WebSocket-only accumulation mode. The REST host rejects Binance trading API hostnames. No REST depth polling occurs. If REST bootstrap returns HTTP 418 or an IP-ban response, the backend pauses historical REST requests until the supplied ban-expiry/`Retry-After` duration passes, then retries missing symbol histories with backoff; the live WebSocket remains connected throughout. Until verified history is restored, the frontend correctly reports 503/live data unavailable and paper entries remain blocked. A recent trade tick is preferred for displayed prices; when a symbol has no recent trade, its price is the midpoint of the fresh Binance best bid and ask. Both trade and depth prices are real exchange data. REST requests are serialized with a minimum 150ms gap. The scanner calculates indicators only from verified closed candles; no market data is generated locally.

Paper entries and exits use a fresh Binance Spot depth quote (best ask for buys, best bid for sells) with a 0.075% adverse execution adjustment per fill. Existing positions are monitored against real Binance kline highs/lows and remain open when a fresh execution quote is unavailable. This service is paper-only and does not send exchange orders.

## Browser notifications and uptime checks

Enable browser trade alerts from the dashboard header. The frontend requests notification permission and registers a service worker, then detects trade entry, exit, and losing-stop cooldown changes through its three-second backend polling. Notifications can appear while the page is open or backgrounded, subject to browser throttling.

The backend also sends ntfy.sh alerts directly for paper trade entries, exits, and daily loss-limit trips, so those alerts do not depend on the dashboard being open. Configure `NTFY_TOPIC` in the backend environment (default: `auraalgo_live_897k3_rajesh`). ntfy topics are public to anyone who knows their name; replace the default with a long, random topic and keep it private. Failed/timed-out notification requests are logged and do not affect trade execution.

Configure an external uptime monitor to request `GET /api/health/live`. This lightweight endpoint returns HTTP 200 with `{ "status": "ok", "timestamp": "..." }` without querying MongoDB or Binance. It can help keep a Render instance warm but does not replace an always-on Render plan for continuous trading.

## Trading defaults

- Symbols: ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, ADAUSDT, AVAXUSDT.
- The scanner evaluates both 5-minute and 15-minute Binance candles. A 15-minute setup can enter independently; a 5-minute setup is allowed only when the same symbol also has a qualifying 15-minute signal in the same direction. Both intervals require at least 7 aligned directional votes, ADX-14 of at least 22, strict close/EMA20/EMA50 alignment, the close strictly above/below EMA-200 for long/short entries, current closed-candle volume at least 1.2x the prior 20-candle average, and at least 54% matching top-20 Binance book pressure.
- Scans run only when all six symbols have aligned, verified closed candles for the relevant interval. Up to three positions can be open at once (`MAX_OPEN_TRADES`, default 3), with at most one open position per symbol. Positions risk 0.75% of the virtual wallet each; entries are also bounded by available margin and the daily-loss safeguards.
- Initial stop distance is 1.5 ATR. At +1R, the stop moves to fee-adjusted breakeven (entry plus/minus 0.35%). At +1.3R, half the initial quantity closes at the current market quote and the remaining stop locks at least +0.6R. Above +1.8R, the remaining position trails the best price by 0.75 ATR and targets +2.5R.
- Quantity is calculated directly as `(wallet balance * 0.0075) / absolute(entry price - stop price)`. Entries are skipped if their required margin plus entry fee exceeds available margin. Leverage defaults to 1x.
- Each fill includes a 0.075% taker fee as well as the existing adverse execution adjustment. Entry fees reduce available margin immediately; partial and final realized P&L include allocated entry fees and exit fees.
- If a stop and target are both touched within one candle, the stop is assumed to fill first. Opposing qualified momentum signals can close a position early. Two consecutive net-losing closed trades during the same UTC day pause new entries until the next UTC day (`DAILY_CONSECUTIVE_LOSS_LIMIT`, default 2); the realized daily-loss amount limit remains an independent guard. Existing positions continue to be monitored.
- A net-losing stop-loss records the closed-candle indicator/volume snapshot and applies a three-candle symbol cooldown (45 minutes on the default 15-minute interval). Two consecutive net-losing closes for one symbol within 12 hours extend its cooldown to six hours. A unique partial MongoDB index enforces at most one open position per symbol; the legacy account-wide index is removed at startup. Wallet reservations and trade opens/closes use MongoDB transactions, so use an Atlas replica set (Atlas clusters support this).

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
| GET | `/api/agent/context` | Authenticated, sanitized read-only snapshot: bot/feed status, wallet, recent trades, and market prices |
| GET | `/` | Small public service health response (also used by Haki connection test) |
| POST | `/assistant/query` | Authenticated Gemini voice query; returns `{ "response": "..." }` |
| POST | `/api/bot/start` | Start scanning; Bearer token required |
| POST | `/api/bot/stop` | Pause new entries while continuing to monitor/close open positions; Bearer token required |
| POST | `/api/trades/:id/close` | Close an open paper trade at latest price; Bearer token required |

Set `BOT_CONTROL_TOKEN` on the backend and send `Authorization: Bearer <token>` for every control request. Keep this token on a trusted server; never embed it in browser-delivered Vercel code. Configure `ALLOWED_ORIGINS` as a comma-separated list. `*.vercel.app` and local development origins are also allowed.

### AI agent read API

The read-only agent endpoint returns a sanitized snapshot and does not grant bot-control permissions. Set a unique, long random `AI_READ_API_TOKEN` on the backend; do not reuse `BOT_CONTROL_TOKEN` or expose either token in browser code. Configure `AI_READ_POLL_INTERVAL_SECONDS` if needed (default 15; allowed range 5–3600). Authenticated agent requests share an in-memory limit of 60 requests per minute per backend process.

Generate a token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and set the result as `AI_READ_API_TOKEN` in the backend's private environment. Give the same value only to the trusted AI integration.

Give your agent this connection configuration:

```text
Webapp name: AuraAlgo Crypto Paper Trading
API base URL: https://<your-backend-host>/api/agent
API auth: Bearer <the AI_READ_API_TOKEN you configured privately>
Context endpoint: GET {API base URL}/context
Status polling interval: 15 seconds (or your configured AI_READ_POLL_INTERVAL_SECONDS)
```

Send the token in the `Authorization` header. The endpoint returns one JSON snapshot containing selected bot/feed status, paper-wallet balances and P&L, up to 50 selected fields from recent paper trades, and each configured market's price/readiness. It omits audit logs, diagnostics, and unapproved database fields. It is read-only and returns `401` for a missing/invalid token, `429` when rate-limited, or `503` if its service credential is not configured. Do not put the token in a URL or prompt that may be logged. Example:

```http
GET /api/agent/context HTTP/1.1
Host: <your-backend-host>
Authorization: Bearer <AI_READ_API_TOKEN>
Accept: application/json
```

### Haki Android voice assistant

Configure Haki with the Render backend's HTTPS origin as its base URL (do not add a path):

```text
BASE URL: https://<your-render-service>.onrender.com
Auth: Bearer key required
Key: the backend AI_READ_API_TOKEN value, stored in Haki's secure credential setting
Connection test: GET {BASE URL}/
Voice request: POST {BASE URL}/assistant/query
Content-Type: application/json
Body: {"query":"recognized speech"}
```

The same private `AI_READ_API_TOKEN` protects the read-only context and voice-query routes. Generate/configure it only in the backend host's private environment and Haki's secure credential storage; never place it in a URL or client source code. The GET root health check does not require the key. The query accepts a non-empty `query` up to 1,000 characters, and the JSON request body is capped at 16 KB; requests are rate-limited. The backend uses the existing Google Gen AI SDK and requires `GEMINI_API_KEY` in the backend host's private environment. It returns HTTP 503 with `missingConfiguration: "GEMINI_API_KEY"` until configured; provider failures return a generic HTTP 502 without logging provider error details. A sanitized trading snapshot and the recognized query are sent to Gemini to generate the spoken answer; the response is limited to 2,000 characters. The system prompt requires an answer in the query's language (Hindi/Marathi/English including transliteration) and prohibits trading/funds/settings actions.

Create a Gemini API key in Google AI Studio and add it as `GEMINI_API_KEY` only in the Render backend service's private Environment settings. The Haki Bearer key is a separate `AI_READ_API_TOKEN`; do not use the Gemini key in Haki.

The current backend stores one primary paper wallet and account-wide trades; it has no user/tenant identifiers or login-based tenant isolation. The agent token grants read access only to that single app account. Do not use this API for a multi-tenant deployment without adding an appropriate account authorization model.

## Render deployment

Create a Node web service rooted at `trading-bot-backend`, build command `npm install`, start command `npm start`, and set the environment variables above in Render. Use an always-on Render instance for continuous scanning; a sleeping instance cannot process candles. MongoDB data persists in Atlas. Binance public market-data outages reconnect automatically with exponential backoff; inspect service logs and `/api/health/ready` for failures.
