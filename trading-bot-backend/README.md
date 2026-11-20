# Paper Trading Backend

Node.js/Express paper-trading service using MongoDB Atlas and Binance public Spot market data. It does not submit orders to Binance and requires no exchange credentials.

## Run locally

1. Use Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` and a private `BOT_CONTROL_TOKEN`.
3. Run `npm install`, `npm test`, and `npm start`.

The service initializes one wallet with `INITIAL_BALANCE_USDT` (default 10,000 USDT), then sequentially bootstraps exactly 500 unique, contiguous, completed candles for each of ten configured pairs: BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, SUI, and NEAR, all against USDT. It receives candle closes, trade ticks, and optional top-20 depth through one combined WebSocket (`BINANCE_WS_URL`, default `wss://data-stream.binance.vision/stream`). Set `BINANCE_REST_BOOTSTRAP_ENABLED=false` to start directly in WebSocket-only accumulation mode. The REST host rejects Binance trading API hostnames. No REST depth polling occurs. If REST bootstrap returns HTTP 418 or an IP-ban response, the backend pauses historical REST requests until the supplied ban-expiry/`Retry-After` duration passes, then retries missing symbol histories with backoff; the live WebSocket remains connected throughout. Until verified history is restored, the frontend reports live data unavailable and paper entries remain blocked. A recent Binance trade tick is required for entry/exit fills; depth is optional context and does not gate signals. REST requests are serialized with a minimum 150ms gap. The scanner calculates indicators only from verified closed candles; no market data is generated locally.

Paper entries and exits use fresh Binance trade ticks as simulated fills, with no synthetic slippage or fee deduction. Existing positions are monitored and remain open when a fresh execution tick is unavailable. This service is paper-only and does not send exchange orders.

## Browser notifications and uptime checks

Enable browser trade alerts from the dashboard header. The frontend requests notification permission and registers a service worker, then detects trade entry, exit, and losing-stop cooldown changes through its three-second backend polling. Top-two opportunity and profitable TP1/TP2 events use optional confetti and synthesized audio; audio is muted until enabled in the header. Notifications can appear while the page is open or backgrounded, subject to browser throttling.

The backend also sends ntfy.sh alerts directly for paper trade entries, exits, and daily loss-limit trips, so those alerts do not depend on the dashboard being open. Configure `NTFY_TOPIC` in the backend environment (default: `auraalgo_live_897k3_rajesh`). ntfy topics are public to anyone who knows their name; replace the default with a long, random topic and keep it private. Failed/timed-out notification requests are logged and do not affect trade execution.

Configure an external uptime monitor to request `GET /api/health/live`. This lightweight endpoint returns HTTP 200 with `{ "status": "ok", "timestamp": "..." }` without querying MongoDB or Binance. It can help keep a Render instance warm but does not replace an always-on Render plan for continuous trading.

## Trading defaults

- Auto-scanned pairs: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, AVAXUSDT, SUIUSDT, and NEARUSDT. The frontend may chart PEPE or custom USDT symbols, but they are not eligible for automatic entries.
- The engine bootstraps 500 valid closed candles per symbol and evaluates its configured 5-minute/15-minute entry intervals. It retains up to 830 contiguous 15-minute candles from the existing WebSocket stream for 1H/4H resampling; the strategy still uses the latest 500 for its base indicators and API candle responses remain 500. No additional Binance REST requests are made. Each of ten equally weighted sources votes: EMA-200, EMA-20/50 ribbon, Supertrend (10,3), RSI-14, MACD (12,26,9), Stochastic RSI (14,14,3,3), Bollinger Bands (20,2), ADX/+DI/-DI (14), OBV vs its 20-period SMA, and ATR-14 with the latest candle body direction.
- A LONG/SHORT needs at least 7 matching directional votes, strict close/EMA-200 and EMA-20/EMA-50 alignment, directionally aligned ADX/DI, ADX strictly above 22, and a latest closed-candle volume ratio of at least 1.2. RSI above 68 blocks LONG; RSI below 32 blocks SHORT. Order-book imbalance is not an entry gate.
- Complete 15m bars are grouped in fours for 1H and sixteens for 4H. The trend is BULLISH when close and EMA20 are above EMA50, BEARISH when both are below, and otherwise NEUTRAL; EMA200 is reported when enough bars exist. Both HTF trends opposing the 15m direction block an entry. Because 500 15m candles form only 31 complete 4H bars, the 4H trend remains NEUTRAL until streaming history includes at least 50 complete 4H bars.
- Qualifying setups are ranked by `volumeSpikeRatio * ADX`; the scanner considers only the top two per scan, with alphabetic symbol tie-breaking. The existing account-wide position limit remains three (`MAX_OPEN_TRADES`, default 3), with at most one open position per symbol.
- A+ setups with both HTFs aligned allocate `min(35% of available margin, $3,500 USDT)`; standard/mixed/neutral setups allocate `min(25%, $2,500 USDT)`. Quantity is allocated margin divided by entry price. Initial stop and TP1 are each 1.5 ATR from entry; TP2 is 3 ATR. At TP1, half of the initial quantity is realized and the remaining stop moves to entry plus/minus 0.35%. TP2 or the protective stop closes the remainder. There is no early momentum-reversal exit or synthetic fee/slippage.
- Three consecutive net-losing closed trades or a realized UTC-day loss of 5% of day-start equity pauses new entries through the next UTC day. The breaker is persisted in MongoDB; existing positions continue to be monitored and exited. Wallet and trade changes use MongoDB transactions, so use an Atlas replica set (Atlas clusters support this).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health/live` | Liveness probe |
| GET | `/api/health/ready` | MongoDB readiness probe |
| GET | `/api/bot/status` | Runtime state, configured symbols, latest prices |
| GET | `/api/bot/audit` | Recent in-memory engine, trade, and feed events |
| GET | `/api/wallet` | Paper wallet and margin balances |
| GET | `/api/trades?status=OPEN&limit=50` | Recent paper trades (OPEN/CLOSED, 1–200) |
| GET | `/api/market/status` | Verified live prices, 500 closed candles, ten indicator votes, opportunity scores/top-two flags, optional L2 context, and tick/countdown metadata |
| GET | `/api/market/:symbol/candles` | Exactly 500 completed Binance candles |
| GET | `/api/market/:symbol/indicators` | Ten indicators computed from completed Binance candles |
| GET | `/api/market/:symbol/orderbook` | Optional top-20 levels from the Binance depth stream |
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
