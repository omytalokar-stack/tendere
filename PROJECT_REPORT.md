# AuraAlgo Crypto Paper Trading — Project aur Algorithm Report

**Report date:** 20 November 2026
**Project:** AuraAlgo Crypto Paper Trading  
**Scope:** Yeh report repository ke frontend, backend, configuration, models aur documentation ko padhkar banayi gayi hai. Yeh source-code walkthrough hai; is report ke liye production uptime, current account state ya trading performance ka live audit nahi kiya gaya.

## 1. Ek nazar mein

AuraAlgo ek browser-based crypto market dashboard aur Node.js paper-trading backend hai. Backend Binance ke **public Spot market-data** endpoints se candles, trades aur order-book data leta hai. Phir finalized candles par technical indicators nikal kar rule-based signal banata hai aur MongoDB mein virtual wallet/trades update karta hai.

**Yeh real trading bot nahi hai:** Binance par koi order place nahi hota, exchange account/API key ki zaroorat nahi hoti, aur wallet mein asli paisa nahi hota. LONG/SHORT positions simulated hain. SHORT ko Spot market par execute nahi kiya jata. Simulated result se future profit ya live execution quality ka wada nahi hota.

### Is project mein kya hai

- React + TypeScript + Vite dashboard; installable PWA.
- Node.js + Express + Mongoose trading backend.
- Binance public REST se historical candle bootstrap aur WebSocket se live market feed.
- Ten-source closed-candle consensus, top-two opportunity ranking, ATR-based simulated sizing/exits, and persisted daily circuit breakers.
- MongoDB-backed virtual wallet, trade history, bot state aur audit events.
- Optional browser/ntfy alerts aur alag read-only Gemini voice assistant integration.

## 2. User ko webapp mein kya dikhta hai

Webapp mobile-first dark dashboard hai. Neeche fixed navigation se chaar main screens khulti hain: **Home, Strategy, Brain Health, Wallet**. Upar AuraAlgo branding, browser-alert toggle aur Binance feed ka live/offline indicator rehta hai. Mobile par ise browser se install karke standalone PWA ki tarah bhi khola ja sakta hai.

### Home — live position aur exposure

- Pehle load par skeleton cards dikhte hain. Backend snapshot aane ke baad hi live account/market data render hota hai.
- Agar verified market data taiyar nahi hai, Home position cards ki jagah “Waiting for verified market data” state dikhata hai. Is samay sample price se kaam chalane ki koshish nahi hoti.
- Agar market ready hai lekin koi open position nahi, Home batata hai ki engine cash mein wait kar raha hai; “Peek at the ten-coin scanner” Strategy screen kholta hai. Signal na milna normal hai.
- Har open cloud paper position ke card mein pair, LONG/SHORT side, entry aur live Binance price, clean simulated unrealized P&L, stop, TP1/TP2 aur target progress dikhte hain.
- Live mark P&L pehle se realized partial P&L aur bachi hui quantity ka price P&L jodta hai. Fills mein synthetic fee/slippage nahi lagti; execution fresh verified Binance trade ticks par hoti hai.
- “Emergency close” pehle confirmation mangta hai. Confirm karne par authorized backend gateway ko close request bheji jaati hai. Fresh Binance quote na ho to backend fabricated fill nahi karta aur position khuli reh sakti hai.

### Strategy — ten-market scanner aur indicator inspector

- Ten backend cards BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, SUI aur NEAR pairs ke verified price, ten BUY/SELL/NEUTRAL votes, top-two rank aur opportunity score dikhate hain. Core pairs ke collapsible screener mein ALL, OPPORTUNITIES, LONGS aur SHORTS filters hain.
- Kisi card ko chunne par ten-indicator detail, volume ratio, optional L2 context aur recent swing-risk summary khulti hai. Order-book imbalance entry gate nahi hai.
- Entry ke liye kam-se-kam 7 aligned votes, strict EMA-200/ribbon/ADX trend alignment, ADX `>22`, volume ratio `>=1.2`, RSI extreme guard aur circuit-breaker/risk limits pass hone chahiye.
- Upar ka market terminal BTC/ETH/SOL/BNB/XRP/DOGE/ADA/AVAX/SUI/NEAR quick pairs, PEPE, custom USDT search aur 5m/15m/1h/4h/1d timeframe deta hai. Binance public REST/WebSocket se 500 closed candles, live tick count, price change, connection state aur close countdown aate hain.
- Interactive chart `lightweight-charts` candlestick + volume render karta hai; EMA 20/50/200, Supertrend (10,3) aur Bollinger Bands (20,2) overlays toggle ho sakte hain. Crosshair par OHLCV readout hai. Overlay calculations closed candles par hote hain, live candle WebSocket se update hoti hai.
- 500-candle audit modal candle statistics, searchable/paginated OHLCV aur indicator values, aur CSV download deta hai. PEPE/custom symbols chart/watchlist aur manual local booking ke liye hain; auto-scanner ke liye nahi.
- “Recent swing & ATR risk” pichhli 50 closed candles ka high/low aur 1.5× ATR stop-distance dikhata hai. “Near recent swing” sirf wick-risk warning hai, liquidation map ya guaranteed stop prediction nahi.

### Brain Health — connection, risk aur bot controls

- Status cards Binance WebSocket connection, 10-market readiness, frontend API refresh latency, sabse purane live quote ki age aur persisted circuit-breaker state dikhate hain.
- Per-market health row quote age, 500-candle count aur optional order-book context dikhati hai. Order-book levels signal readiness ki shart nahi hain.
- Audit panel backend process ke recent feed, engine aur trade events dikhata hai. Yeh permanent database audit archive nahi; process restart ke baad purane in-memory events rehne ki guarantee nahi.
- “Enable entries” / “Pause entries” persisted bot setting badalta hai. Pause karne se **nayi entries** rukti hain; existing positions ka stop/target monitoring aur exit processing chalti rehti hai.
- Control action browser mein secret token rakhkar nahi chalta: request `/api/control/...` gateway par jaati hai, jo server-side authorization ke baad backend tak pahunchata hai. Production access ko trusted users tak simit rakhna zaroori hai.

### Wallet — virtual balance, result history aur app settings

- Cloud Wallet card starting margin, current virtual balance, available margin aur open-trade margin dikhata hai. Backend unavailable ho to `auraalgo-local` IndexedDB account `$10,000` se shuru hota hai.
- Realized net P&L ke saath win/loss counts dikhte hain. Yeh paper trades ke recorded results hain, real exchange account ka balance nahi.
- Realized equity curve latest closed trades se balance path banati hai. Cloud closed-trade table pair/side, entry/exit, legacy fee field, net P&L, exit reason aur close time dikhati hai; local account ke liye open positions aur full order-history views alag hain.
- Settings mein PWA install action aur install message/instructions hain. iOS par Safari Share > Add to Home Screen; Android/desktop par browser install prompt/menu ka istemal hota hai.
- Local mode mein manual LONG/SHORT paper booking, 25% available-margin sizing (max `$2,500`), 1.5 ATR stop/TP1, 3 ATR TP2, tick-based SL/TP exits, TP1 50% partial fill, breakeven +0.35% stop aur equity adjustment milte hain. Open positions aur history IndexedDB mein rehti hain. Local trading/exit management ko public live Binance ticks chahiye; network bilkul offline ho to simulated price generate nahi hota.

### Alerts aur notification behavior

- Header se browser notifications aur Web Audio feedback alag toggles se enable/mute hote hain. Browser notification ke liye permission, service worker aur local preference chahiye; synthesized chime ke saath Top-2 opportunity aur profitable TP1/TP2 par confetti feedback ho sakta hai.
- App polling naye cloud trade open/close, TP1 aur losing stop ke baad cooldown detect karta hai. Pehli successful snapshot baseline set karti hai—app start hote waqt purane trades ko naye alert ke roop mein bhejne se bachne ke liye.
- Browser notifications dashboard ke polling aur browser permission/throttling par nirbhar hain; page band/suspended ho to delivery guaranteed nahi.
- Backend ka optional ntfy notification path trade open/close aur daily loss-limit event ke liye alag chalta hai. Notification fail hone se trading-engine accounting nahi rukti. `NTFY_TOPIC` ko secret-jaisa private rakhein, kyunki topic jaanne wala koi bhi subscribe/publish kar sakta hai.

### App ke bahar ke optional integration

- Backend ka `/api/agent/context` endpoint auth ke peeche sanitized, read-only status/wallet/trade/market snapshot deta hai; yeh bot-control permission nahi deta.
- `/assistant/query` configured Gemini provider ko user query aur sanitized snapshot bhej kar text response la sakta hai. Is integration ka UI is React dashboard mein nahi hai; yeh alag Haki voice assistant ya authorized client ke liye backend capability hai.
- Gemini API key backend environment mein aur AI read token alag secret ke roop mein rakhe jaate hain. In dono ko frontend bundle mein nahi rakhna chahiye.

## 3. Codebase aur webapp banane ke tools

Yeh ek repository mein rakha frontend aur alag backend service hai; dono apne package manifest aur run command rakhte hain.

| Hissa | Technology | Is project mein zimmedari |
|---|---|---|
| Frontend | React 19, TypeScript, Vite 8 | Single-page dashboard, typed API responses, PWA build/dev server |
| Styling/UI | Tailwind CSS 4, Lucide icons, Motion dependency | Dark responsive UI, icons aur visual effects |
| Backend | Node.js 20+, Express 5, CommonJS | HTTP API, access control, market engine lifecycle |
| Persistence | MongoDB + Mongoose 9; browser IndexedDB fallback | Cloud wallet/trade/risk state aur local paper account |
| Indicators | `technicalindicators` + project calculations | Ten-source consensus, RSI/EMA/MACD/Bollinger/ATR/ADX/OBV/Supertrend |
| Market source | Binance public Spot REST + WebSocket | Candle history, trade ticks/klines; optional top-20 depth |
| Optional AI | Google GenAI SDK / Gemini | Authenticated read-only assistant response |
| Hosting pattern | Vercel frontend/gateway + Render backend + MongoDB Atlas | Static frontend, server-side control relay, persistent data |

### Important files ka kaam

- [`src/main.tsx`](./src/main.tsx): React root mount aur app startup.
- [`src/App.tsx`](./src/App.tsx): navigation, 3-second polling, cloud/local account fallback, notifications/audio aur authorized user actions.
- [`src/services/backendApi.ts`](./src/services/backendApi.ts): backend request helpers, TypeScript data shapes, snapshot/candle validation aur control-gateway calls.
- [`src/services/binanceMarketData.ts`](./src/services/binanceMarketData.ts): browser terminal ke Binance public history/tick/kline REST/WebSocket helpers.
- [`src/components/MarketTerminal.tsx`](./src/components/MarketTerminal.tsx) aur [`src/components/TerminalChart.tsx`](./src/components/TerminalChart.tsx): multi-timeframe terminal, live quote/countdown aur chart overlays.
- [`src/utils/indicators.ts`](./src/utils/indicators.ts) aur [`src/utils/screener.ts`](./src/utils/screener.ts): local ten-indicator math aur top-two ranking.
- [`src/utils/browserDatabase.ts`](./src/utils/browserDatabase.ts) aur [`src/components/LocalPaperWallet.tsx`](./src/components/LocalPaperWallet.tsx): IndexedDB, local tick exits, manual booking aur order history.
- [`src/components/OpportunityScreener.tsx`](./src/components/OpportunityScreener.tsx): collapsible ten-pair screener, candle audit aur CSV export.
- [`src/services/notificationService.ts`](./src/services/notificationService.ts): browser permission, trade notifications, Web Audio aur confetti feedback.
- [`trading-bot-backend/src/server.js`](./trading-bot-backend/src/server.js): MongoDB startup, model/index initialization, wallet/bot-state restore, engine/server lifecycle aur graceful shutdown.
- [`trading-bot-backend/src/app.js`](./trading-bot-backend/src/app.js): public read APIs, authenticated controls, CORS/body validation, assistant/read-only endpoints aur error responses.
- [`trading-bot-backend/src/services/binanceFeed.js`](./trading-bot-backend/src/services/binanceFeed.js): REST bootstrap, WebSocket events, validation/reconnect.
- [`trading-bot-backend/src/services/strategy.js`](./trading-bot-backend/src/services/strategy.js): deterministic indicator votes, entry decision aur position sizing.
- [`trading-bot-backend/src/services/paperTradingEngine.js`](./trading-bot-backend/src/services/paperTradingEngine.js): scanning, simulated fills, position management, wallet accounting, circuit breakers aur audit events.
- [`trading-bot-backend/src/models/`](./trading-bot-backend/src/models): persisted BotState, VirtualWallet, PaperTrade aur DailyRiskState schemas/indexes.
- [`api/control/[...path].js`](./api/control/%5B...path%5D.js): Vercel server-side control gateway; browser token ko expose kiye bina allowlisted action relay karta hai.
- [`vercel.json`](./vercel.json): read-only `/api/*` calls ko configured Render backend par rewrite karta hai; `/api/control` rewrite se exclude hai.
- [`public/manifest.webmanifest`](./public/manifest.webmanifest) aur [`public/sw.js`](./public/sw.js): install metadata, static app-shell cache, offline navigation fallback aur notification-click handling.
- `trading-bot-backend/test/`: strategy, feed, engine, API, auth/rate-limit, assistant aur notification regression tests.

### Local development ka tareeqa

Do alag terminals/processes chahiye, kyunki frontend aur backend alag servers hain:

1. Backend ke liye Node.js 20+, MongoDB Atlas/local replica-set connection aur private environment settings (`MONGODB_URI`, `BOT_CONTROL_TOKEN`) configure karein. `.env` ki values ko source control/chat/report mein na daalein.
2. `trading-bot-backend` folder mein `npm install`, `npm test`, `npm start` chalayein. Backend default port 3001 par API, MongoDB persistence aur Binance feed chalata hai.
3. Repository root mein `npm install`, `npm run dev` chalayein. Vite default port 3000 par frontend serve karta hai; development proxy `/api` requests ko backend tak bhejta hai.
4. `http://localhost:3000` kholkar UI dekhein; backend readiness `http://localhost:3000/api/health/ready` se check ki ja sakti hai.

Root package scripts: `npm run dev`, `npm run build`, `npm run preview`, `npm run lint` (`tsc --noEmit`). Backend scripts: `npm start`, `npm run dev` (Node watch mode), `npm test` (`node --test`).

Production deployment mein Vercel frontend/read routing aur serverless control gateway host karta hai; Render Node backend host karta hai; Atlas database host karta hai. Vercel gateway ke liye `PAPER_TRADING_API_URL`, `BOT_CONTROL_TOKEN`, exact `CONTROL_DASHBOARD_ORIGIN` chahiye; frontend ke read requests ke liye current rewrite Render host ko point karta hai. Render par MongoDB/control credentials aur browser origin allowlist backend environment mein set hote hain. Deployment hostname ya live status badal sakta hai; is report mein live verification shamil nahi.

## 4. System architecture aur data flow

```text
Browser (React / TypeScript / Vite)
  ├─ read requests: dashboard -> /api/* -> backend
  ├─ control requests: dashboard -> /api/control gateway -> backend
  └─ UI: Home, Strategy, Brain Health, Wallet, chart, alerts

Node.js / Express backend
  ├─ MongoDB: BotState, VirtualWallet, PaperTrade
  ├─ Binance public REST: candle history
  ├─ Binance combined WebSocket: klines, trades, depth20
  └─ Strategy -> risk checks -> simulated fill -> wallet/trade transaction
```

### Browser application

- [`src/App.tsx`](./src/App.tsx) mein dashboard state, polling, cloud/local fallback aur tabs render hote hain.
- [`src/services/backendApi.ts`](./src/services/backendApi.ts) backend se status, wallet, trades aur ten market snapshots padhta hai; incomplete market/indicator response reject hota hai.
- [`src/components/MarketTerminal.tsx`](./src/components/MarketTerminal.tsx) symbol/timeframe search, browser websocket, quote countdown aur interactive chart control karta hai.
- `public/manifest.webmanifest` aur `public/sw.js` PWA install/service-worker experience ke liye hain.
- Browser alerts page polling ke zariye trade state changes dekhte hain. Dashboard background mein ho ya band ho to browser notification timing browser par nirbhar ho sakti hai.

### Backend

- [`trading-bot-backend/src/server.js`](./trading-bot-backend/src/server.js) MongoDB connect karta hai, models/indexes initialize karta hai, persisted bot state restore karke engine start karta hai aur HTTP server chalata hai.
- [`trading-bot-backend/src/services/binanceFeed.js`](./trading-bot-backend/src/services/binanceFeed.js) REST history, WebSocket events, input validation, reconnect aur bootstrap retry sambhalta hai.
- [`trading-bot-backend/src/services/strategy.js`](./trading-bot-backend/src/services/strategy.js) indicators, votes, signal gates aur quantity calculation rakhta hai.
- [`trading-bot-backend/src/services/paperTradingEngine.js`](./trading-bot-backend/src/services/paperTradingEngine.js) top-two scan, simulated tick fills/exits, wallet accounting aur persisted daily breaker sambhalta hai.
- [`trading-bot-backend/src/app.js`](./trading-bot-backend/src/app.js) API routes, CORS, validation, authentication aur error responses deta hai.

## 5. Market data kaise milta aur verify hota hai

### Symbols aur intervals

Backend 10 USDT pairs dekhta hai: **BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, AVAXUSDT, SUIUSDT, NEARUSDT**. Default candle interval `15m` hai aur entry scan `5m` aur `15m` par hota hai. Configuration interval ko badal sakti hai; [`trading-bot-backend/src/config.js`](./trading-bot-backend/src/config.js) dekhein.

### Startup aur live feed

1. Default REST host `data-api.binance.vision` se har configured symbol/entry interval ke liye **500 finalized candles** laayi jaati hain.
2. History mein timestamps unique aur candles contiguous hone chahiye. Missing candle, gap, invalid field ya incomplete history ko feed error maana jata hai.
3. REST requests serialize hote hain aur unke beech kam-se-kam 150 ms ka gap hai. Symbols bootstrap karte waqt additional delay hai.
4. Ek combined Binance WebSocket se candle klines, trade ticks aur `depth20` order-book updates aate hain.
5. Candle analysis sirf **closed/final** candles par hota hai. In-progress candles trade exit check trigger kar sakti hain, par un par naya indicator-based entry nahi hota.
6. Trade tick 15 seconds se zyada purana ho to use fresh execution data nahi maana jata. Depth stream optional display context hai. WebSocket disconnect par reconnect exponential backoff se hota hai; incomplete candle history bootstrap retry karti hai.

### Fail-closed behavior

Dashboard/entry scanner tab tak market ko ready nahi maante jab tak sab core symbols ke valid closed candles aur fresh Binance trade ticks available na hon. Order-book depth optional hai aur signal ko gate nahi karta. Invalid/stale candle ya tick par API error/503 de sakti hai aur nayi entries rukti hain. Frontend market data ko sample data se replace nahi karta.

Dashboard ke cloud fills recent verified trade ticks se hote hain. Browser terminal aur local fallback Binance ke public REST/WebSocket market-data hosts se direct candles/ticks lete hain; credentials ki zaroorat nahi hoti.

## 6. Signal/strategy algorithm — seedhe steps

`analyzeCandles()` exactly 500 valid closed candles validate karke 10 equally weighted votes nikalta hai. Indicator calculations `technicalindicators` package aur local Supertrend calculation par aadharit hain.

| # | Vote source | BULLISH condition | BEARISH condition | Note |
|---|---|---|---|---|
| 1 | EMA-200 macro trend | Close `> EMA200` | Close `< EMA200` | Macro direction |
| 2 | EMA-20/50 ribbon | EMA20 `> EMA50` | EMA20 `< EMA50` | Trend alignment |
| 3 | Supertrend (10, 3) | Supertrend bullish | Supertrend bearish | ATR trend direction |
| 4 | RSI-14 Wilder | RSI `<=35` is bullish zone | RSI `>=65` is bearish zone | Extreme entry guard is separate |
| 5 | MACD (12, 26, 9) | Histogram `>0` | Histogram `<0` | Line vs signal |
| 6 | Stochastic RSI (14,14,3,3) | K > D, with oversold-zone bias | K < D, with overbought-zone bias | K/D crossover and zone |
| 7 | Bollinger Bands (20,2) | Price above midline / `%B >0.5` | Price below midline / `%B <0.5` | Position within bands |
| 8 | ADX/+DI/-DI (14) | ADX `>=20` and +DI > -DI | ADX `>=20` and -DI > +DI | Otherwise neutral |
| 9 | OBV vs SMA-20 | OBV > its SMA20 | OBV < its SMA20 | Volume direction |
| 10 | ATR-14 + candle body | Latest candle closes above open | Latest candle closes below open | ATR is reported; body sets vote |

Har vote ka weight 1 hai. RSI zone `35/65` scoring rule hai, jabki entry guard LONG ko RSI `>68` aur SHORT ko RSI `<32` par rokta hai.

### Entry ke tamam gates

Direction tabhi qualify karti hai jab ye sab lagu conditions poori hon:

1. Bot enabled ho, Binance feed connected ho aur market data ready ho.
2. Us interval mein sabhi 10 core symbols ki 500-candle histories complete hon aur unki latest closed candle scan ke liye align ho.
3. Open positions ki tadaad configured maximum (`MAX_OPEN_TRADES`, default 3) se kam ho; har symbol par ek hi open position ho sakti hai.
4. Persisted daily circuit breaker trigger na hua ho: teen consecutive net-losing closes ya UTC day-start equity ka 5% realized net loss.
5. Symbol kisi configured post-loss cooldown mein na ho.
6. Kam-se-kam **7 directional votes** ek taraf hon; LONG ke liye `close > EMA200`, `EMA20 > EMA50` aur bullish ADX/DI; SHORT ke liye ulte directional rules.
7. ADX `>22`, closed-candle volume ratio `>=1.2`, aur RSI extreme guard pass ho.

Qualifying candidates ko `volumeSpikeRatio * ADX` se rank karke sirf top two par auto-entry try hoti hai; equal score par symbol alphabetically sort hota hai. 5-minute entry configured hone par 15-minute same-side confirmation bhi lagu hoti hai. L2 imbalance signal gate nahi hai.

## 7. Position sizing, fills aur trade lifecycle

### Quantity aur planned risk

Default position allocation:

```text
allocated margin = min(available margin × 25%, $2,500 USDT)
quantity = allocated margin ÷ entry price
stop distance = ATR-14 × 1.5
```

Leverage defaults and MongoDB schema remain compatible with existing deployments. Entry tab skip hoti hai jab quantity invalid ho ya 25% margin allocation account ke current available margin se zyada ho.

### Entry/exit simulation

- Entry aur exits fresh verified Binance trade ticks par simulated hote hain; synthetic 0.075% slippage/fee double-drain nahi hai.
- Initial SL aur TP1 `1.5 ATR`; TP2 `3.0 ATR` (2R) hota hai.
- TP1 touch par initial quantity ka 50% realized hota hai; remaining SL LONG ke liye `entry * 1.0035`, SHORT ke liye `entry * 0.9965` hota hai.
- TP2 ya protective stop remaining quantity close karta hai. `EARLY_MOMENTUM_REVERSAL` exit remove hai; minor pullback par forced exit nahi hoti.
- User manual cloud close request kar sakta hai; request existing `/api/control` gateway ke allowlisted route se authorized hoti hai. Fresh live tick na ho to fabricated fill nahi hoti.
- Quote unavailable ho to close ko fabricated price par execute nahi kiya jata; pending exit ko baad ke live tick par dobara try kiya ja sakta hai.

Margin allocation **maximum guaranteed loss nahi** hai. Quote timing, gaps aur paper fill assumptions actual simulated result ko badal sakte hain.

### Wallet aur concurrency safety

`VirtualWallet` mein balance, available margin, in-trade margin, realized P&L aur win/loss counts store hote hain. Entry par allocated margin reserve hota hai; TP1 partial profit aur final exit realized P&L ke saath wallet update karte hain.

Entry/close wallet aur trade changes MongoDB transaction mein hote hain. Scanner ek scan mein qualifying symbols par entry ki koshish karta hai, lekin total concurrent positions teen se zyada nahi ho sakti; available margin aur unique database index har symbol par ek hi open trade enforce karte hain. Startup par purana account-wide index remove hota hai. Transactions ke liye MongoDB Atlas jaise replica-set environment ki zaroorat hoti hai.

Daily circuit-breaker state alag MongoDB `DailyRiskState` model mein persist hoti hai. Teen consecutive net-losing trades ya day-start equity ka 5% realized net loss nayi entries ko UTC day end tak rokta hai; open position monitoring aur exit processing chalti rehti hai.

## 8. Database/model aur API surfaces

### MongoDB models

- [`BotState.js`](./trading-bot-backend/src/models/BotState.js): ek primary bot enabled/paused state.
- [`VirtualWallet.js`](./trading-bot-backend/src/models/VirtualWallet.js): ek primary virtual account aur margin/P&L fields.
- [`PaperTrade.js`](./trading-bot-backend/src/models/PaperTrade.js): simulated position, prices, fees, P&L, close reason aur stop-loss analysis.
- [`DailyRiskState.js`](./trading-bot-backend/src/models/DailyRiskState.js): UTC day-start equity, realized net P&L, loss streak aur persisted entry-pause state.

Trade records aur BotState MongoDB mein persist hote hain. `auditLog` engine process memory mein limited recent events rakhta hai, isliye use permanent audit archive na samjhein.

### Mukhya API

| Method | Path | Kaam |
|---|---|---|
| GET | `/api/health/live` | Process liveness |
| GET | `/api/health/ready` | MongoDB readiness aur engine state |
| GET | `/api/bot/status` | Bot, feed, risk config aur market errors |
| GET | `/api/bot/audit` | Recent in-memory events |
| GET | `/api/market/status` | Ten-market snapshot, ten indicator votes, opportunity score/top-two flags aur tick/countdown metadata |
| GET | `/api/market/:symbol/candles` | Configured symbol ki 500 finalized candles |
| GET | `/api/market/:symbol/indicators` | Indicators/votes |
| GET | `/api/market/:symbol/orderbook` | Optional Binance top-20 book |
| GET | `/api/wallet`, `/api/trades` | Virtual wallet/trade history |
| POST | `/api/bot/start`, `/api/bot/stop` | New entries enable/pause |
| POST | `/api/trades/:id/close` | Authorized paper position close |

Control routes par backend token chahiye. Vercel control gateway exact dashboard origin validate karke sirf allowlisted start/stop/close actions forward karta hai aur token server-side rakhta hai. Dashboard ke browser code mein token hona nahi chahiye.

## 9. AI, alerts aur UI ka daayra

- [`trading-bot-backend/src/services/assistantProvider.js`](./trading-bot-backend/src/services/assistantProvider.js) Gemini se read-only voice response bana sakta hai. Isse sanitized snapshot aur user query di jaati hai; provider ko trades execute/modify karne ka adhikar nahi hai. Iske liye backend par Gemini config aur alag read-token setup chahiye.
- Agent context API read-only aur sanitized hai; ye control token/permissions ka substitute nahi.
- Frontend browser notifications user permission ke baad trade changes par chalti hain. Backend ntfy alerts best-effort hain; notification failure trade accounting ko nahi rokta.
- UI ke tabs: Home, Strategy, Brain Health, Wallet. Dashboard har 3 second par snapshot/audit poll karta hai.

## 10. Configuration aur run/deploy

Backend defaults aur bounds [`trading-bot-backend/src/config.js`](./trading-bot-backend/src/config.js) mein hain:

| Variable | Default/maqsad |
|---|---|
| `MONGODB_URI` | Required database connection |
| `BOT_CONTROL_TOKEN` | Private control auth token |
| `BOT_ENABLED` | Naya BotState bante waqt initial enabled state |
| `INITIAL_BALANCE_USDT` | Default `10000` virtual balance |
| `CANDLE_INTERVAL` | Default `15m` |
| `PAPER_LEVERAGE` | Default `1`, allowed `1–5` |
| `MAX_OPEN_TRADES` | Default and maximum `3` concurrent positions |
| Position allocation | `min(25% of available margin, $2,500 USDT)` |
| Protective levels | SL = 1.5 ATR; TP1 = 1.5 ATR; TP2 = 3 ATR |
| Daily breaker | Persisted: 3 consecutive losses or 5% day-start-equity loss |
| `BINANCE_REST_URL` | Default public market-data host |
| `BINANCE_REST_BOOTSTRAP_ENABLED` | Default `true` |
| `BINANCE_WS_URL` | Default public Binance stream |
| `AI_READ_API_TOKEN`, `GEMINI_API_KEY` | Optional read-only assistant integration |

Secrets ko `.env`/hosting environment mein rakhein; `VITE_` prefix wali value browser mein bundle ho sakti hai, isliye control token/Gemini key us prefix se kabhi na rakhein.

Local run ke liye Node.js 20+ aur backend `.env` (kam-se-kam MongoDB URI/control token) set karke:

```powershell
# Terminal 1
cd trading-bot-backend
npm install
npm start

# Terminal 2, project root se
npm install
npm run dev
```

Frontend `http://localhost:3000` par aur backend default `3001` par chalta hai. Repository README local Vite proxy aur Vercel/Render deployment environment variables samjhata hai: [`README.md`](./README.md) aur [`trading-bot-backend/README.md`](./trading-bot-backend/README.md).

## 11. Jo yeh algorithm **nahi** karta

- Machine learning, AI prediction model ya trained strategy nahi: entry logic fixed deterministic thresholds hain.
- Formal backtest, out-of-sample validation, benchmark, win-rate/profitability proof ya future performance forecast nahi.
- Exchange par real buy/sell order, real account balance, real short borrowing, funding/borrow fee ya exchange order lifecycle nahi.
- Har indicator independent vote nahi: indicators correlated ho sakte hain aur fixed vote count probability/confidence score nahi hota.
- 25% available-margin allocation aur ATR stop koi maximum-loss guarantee nahi; market gaps, tick timing aur simulator assumptions actual P&L ko badal sakte hain.

Isliye ise **market-data-driven paper-trading demo/strategy simulator** samjhein, verified profitable trading system ya financial advice nahi.

## 12. Repository mein kahan se verify karein

- Strategy aur sizing: [`strategy.js`](./trading-bot-backend/src/services/strategy.js)
- Scanner, gates, exits aur wallet accounting: [`paperTradingEngine.js`](./trading-bot-backend/src/services/paperTradingEngine.js)
- Binance bootstrap/streams: [`binanceFeed.js`](./trading-bot-backend/src/services/binanceFeed.js)
- API/auth: [`app.js`](./trading-bot-backend/src/app.js), [`controlAuth.js`](./trading-bot-backend/src/middleware/controlAuth.js), [`api/control/[...path].js`](./api/control/%5B...path%5D.js)
- Frontend data contract/UI: [`backendApi.ts`](./src/services/backendApi.ts), [`App.tsx`](./src/App.tsx)
- Backend automated tests: `trading-bot-backend/test/` (strategy, engine, feed, API, auth/rate-limit aur alerts coverage).
