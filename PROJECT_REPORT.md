# AuraAlgo Crypto Paper Trading — Project aur Algorithm Report

**Report date:** 4 November 2026  
**Project:** AuraAlgo Crypto Paper Trading  
**Scope:** Yeh report repository ke source code aur project documentation ko padhkar banayi gayi hai. Yeh code walkthrough hai, live production status check ya trading-performance certification nahi.

## 1. Ek nazar mein

AuraAlgo ek browser-based crypto market dashboard aur Node.js paper-trading backend hai. Backend Binance ke **public Spot market-data** endpoints se candles, trades aur order-book data leta hai. Phir finalized candles par technical indicators nikal kar rule-based signal banata hai aur MongoDB mein virtual wallet/trades update karta hai.

**Yeh real trading bot nahi hai:** Binance par koi order place nahi hota, exchange account/API key ki zaroorat nahi hoti, aur wallet mein asli paisa nahi hota. LONG/SHORT positions simulated hain. SHORT ko Spot market par execute nahi kiya jata. Simulated result se future profit ya live execution quality ka wada nahi hota.

### Is project mein kya hai

- React + TypeScript + Vite dashboard; installable PWA.
- Node.js + Express + Mongoose trading backend.
- Binance public REST se historical candle bootstrap aur WebSocket se live market feed.
- 10-source indicator consensus, volume/order-book gates, ATR-based simulated risk sizing.
- MongoDB-backed virtual wallet, trade history, bot state aur audit events.
- Optional browser/ntfy alerts aur alag read-only Gemini voice assistant integration.

## 2. System architecture aur data flow

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

- [`src/App.tsx`](./src/App.tsx) mein dashboard state, 3-second polling, control actions aur tabs render hote hain.
- [`src/services/backendApi.ts`](./src/services/backendApi.ts) backend se status, wallet, trades aur markets padhta hai. Frontend incomplete market response ko reject karta hai; sample/fake prices par fallback nahi karta.
- [`src/components/TradingViewProModal.tsx`](./src/components/TradingViewProModal.tsx) verified Binance candles ka chart banata hai; chart ka drawing app ka SVG hai, par chart data backend se aata hai.
- `public/manifest.webmanifest` aur `public/sw.js` PWA install/service-worker experience ke liye hain.
- Browser alerts page polling ke zariye trade state changes dekhte hain. Dashboard background mein ho ya band ho to browser notification timing browser par nirbhar ho sakti hai.

### Backend

- [`trading-bot-backend/src/server.js`](./trading-bot-backend/src/server.js) MongoDB connect karta hai, models/indexes initialize karta hai, persisted bot state restore karke engine start karta hai aur HTTP server chalata hai.
- [`trading-bot-backend/src/services/binanceFeed.js`](./trading-bot-backend/src/services/binanceFeed.js) REST history, WebSocket events, input validation, reconnect aur bootstrap retry sambhalta hai.
- [`trading-bot-backend/src/services/strategy.js`](./trading-bot-backend/src/services/strategy.js) indicators, votes, signal gates aur quantity calculation rakhta hai.
- [`trading-bot-backend/src/services/paperTradingEngine.js`](./trading-bot-backend/src/services/paperTradingEngine.js) scan, simulated entry/exit, fees, wallet accounting aur readiness control karta hai.
- [`trading-bot-backend/src/app.js`](./trading-bot-backend/src/app.js) API routes, CORS, validation, authentication aur error responses deta hai.

## 3. Market data kaise milta aur verify hota hai

### Symbols aur intervals

Backend 6 USDT pairs dekhta hai: **ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, ADAUSDT, AVAXUSDT**. Default candle interval `15m` hai aur entry scan `5m` aur `15m` par hota hai. Configuration interval ko badal sakti hai; [`trading-bot-backend/src/config.js`](./trading-bot-backend/src/config.js) dekhein.

### Startup aur live feed

1. Default REST host `data-api.binance.vision` se har configured symbol/entry interval ke liye **500 finalized candles** laayi jaati hain.
2. History mein timestamps unique aur candles contiguous hone chahiye. Missing candle, gap, invalid field ya incomplete history ko feed error maana jata hai.
3. REST requests serialize hote hain aur unke beech kam-se-kam 150 ms ka gap hai. Symbols bootstrap karte waqt additional delay hai.
4. Ek combined Binance WebSocket se candle klines, trade ticks aur `depth20` order-book updates aate hain.
5. Candle analysis sirf **closed/final** candles par hota hai. In-progress candles trade exit check trigger kar sakti hain, par un par naya indicator-based entry nahi hota.
6. Market/order-book data 15 seconds se zyada purana ho to use fresh execution data nahi maana jata. WebSocket disconnect par reconnect exponential backoff se hota hai; incomplete candle history bootstrap retry karti hai.

### Fail-closed behavior

Dashboard/entry scanner tab tak market ko ready nahi maante jab tak sab symbols ke valid candles, live quote aur top-20 bid/ask data available na ho. Data invalid ya stale ho to API error/503 de sakti hai aur nayi entries rukti hain. Frontend market data ko sample data se replace nahi karta.

UI ka displayed price recent trade tick se aata hai; tick stale ho to fresh best-bid/best-ask midpoint dikh sakta hai (`ORDER_BOOK_MID`). Simulated execution phir bhi actual fresh bid/ask quote se calculate hota hai, midpoint se nahi.

## 4. Signal/strategy algorithm — seedhe steps

`analyzeCandles()` 500-candle closed history aur top-20 order book validate karke 10 votes nikalta hai. Indicator calculations `technicalindicators` package aur local VWAP/Supertrend calculation par aadharit hain.

| # | Vote source | BUY condition | SELL condition | Note |
|---|---|---|---|---|
| 1 | RSI-14 | RSI `<= 35` | RSI `>= 65` | Oversold/overbought threshold rule |
| 2 | MACD (12, 26, 9) | Histogram `> 0` | Histogram `< 0` | Histogram zero par neutral |
| 3 | EMA-20 vs EMA-50 | EMA-20 `> EMA-50` | EMA-20 `< EMA-50` | Relative trend |
| 4 | EMA-200 | Close `> EMA-200` | Close `< EMA-200` | Long-trend filter |
| 5 | Supertrend (10, 3) | Direction BUY | Direction SELL | ATR-10 band calculation |
| 6 | Bollinger (20, 2) | Close middle band se upar | Close middle band se neeche | Vote sirf middle band se; outer-band breakout rule nahi |
| 7 | ATR-14 | Neutral | Neutral | Vote nahi; stop distance sizing mein use hota hai |
| 8 | ADX-14 + DI | ADX `>= 20` aur +DI > -DI | ADX `>= 20` aur -DI > +DI | ADX trend strength threshold se kam ho to neutral |
| 9 | VWAP-500 | Close VWAP se upar | Close VWAP se neeche | Available 500 candles ke typical-price × volume se |
| 10 | Volume vs prior 20 | Ratio `>= 1.15` aur close pichhle close se upar | Ratio `>= 1.15` aur close pichhle close se neeche | Indicator vote ka threshold |

BUY aur SELL votes alag gine jaate hain. ATR ek vote source hai lekin hamesha neutral, isliye maximum 9 directional votes mil sakte hain.

### Entry ke tamam gates

Direction tabhi qualify karti hai jab ye sab lagu conditions poori hon:

1. Bot enabled ho, Binance feed connected ho aur market data ready ho.
2. Us interval mein sabhi 6 symbols ki 500-candle histories complete hon aur unki latest closed candle ka timestamp scan ke liye align ho.
3. Ek hi waqt mein account mein koi open position na ho.
4. UTC din ke realized losing P&L ka sum configured limit tak na pahuncha ho (default `400 USDT`).
5. Symbol kisi net-losing stop ke baad cooldown mein na ho.
6. Kam-se-kam **5 directional votes** ek hi taraf hon.
7. Current closed-candle volume prior 20 candles ke average ka **kam-se-kam 1.2×** ho.
8. Top-20 book ke aggregate base-asset bid quantity ka hissa LONG ke liye `>= 54%`, ya ask quantity ka hissa SHORT ke liye `>= 54%` ho.
9. Fresh order book ho.

**Timeframe rule:** 15-minute signal apne aap qualify kar sakta hai. 5-minute signal ko usi symbol ka qualifying **15-minute signal same direction mein** confirm karna hota hai. Isliye UI par vote majority dikhna apne aap trade ka matlab nahi—volume, order book, timeframe confirmation (sirf 5m entries ke liye) aur account/risk gates bhi pass hone chahiye.

**Order-book nuance:** 54% pressure top-20 levels ki summed **quantity** se nikalta hai, notional value se nahi. Ek hi fresh order book snapshot dono timeframe analyses ko diya jata hai.

## 5. Position sizing, fills aur trade lifecycle

### Quantity aur planned risk

Default risk budget:

```text
risk budget = current virtual wallet balance × 1%
stop distance = ATR-14 × 1.5
quantity = risk budget ÷ abs(entry price − stop price)
margin = quantity × entry price ÷ leverage
```

Leverage default `1x` hai, config range `1–5x`. Leverage margin requirement ko badalta hai, quantity formula ke 1% risk budget ko nahi. Entry tab skip hoti hai jab quantity invalid ho ya margin plus entry fee available margin se zyada ho.

### Entry/exit simulation

- LONG entry: best ask; SHORT entry: best bid.
- LONG exit: best bid; SHORT exit: best ask.
- Har fill par 0.075% adverse slippage simulation: BUY price upar aur SELL price neeche adjust hota hai.
- Har fill par 0.075% taker fee lagti hai. Trade ka net P&L = gross P&L minus entry aur exit fees.
- Target default `2 × stop distance` (2:1 planned reward/risk) par rakha jata hai.
- Price +1R tak pahunchne par stop-loss ko entry price par move karke breakeven stop lagaya jata hai. Initial stop level trade record mein bana rehta hai, taaki +1R ka reference stable rahe.
- Candle ke high/low se stop ya target touch detect hota hai, lekin trade actual simulated close **fresh order-book quote** par hota hai, stop/target price ko guaranteed fill maan kar nahi.
- Agar ek candle mein stop aur target dono touch hon to stop-loss pehle maana jata hai.
- Opposite direction ka qualifying signal existing position ko `EARLY_MOMENTUM_REVERSAL` se close kar sakta hai.
- User manual close request kar sakta hai; uske liye fresh quote aur authorized control request zaroori hai.
- Quote unavailable ho to close ko fabricated price par execute nahi kiya jata; pending exit ko baad ke live tick par dobara try kiya ja sakta hai.

Planned 1% risk **maximum guaranteed loss nahi** hai. Slippage, fees, quote timing, candle gaps aur paper fill assumptions actual loss ko plan se alag kar sakte hain.

### Wallet aur concurrency safety

`VirtualWallet` mein balance, available margin, in-trade margin, realized P&L aur win/loss counts store hote hain. Entry par margin + entry fee reserve hote hain; close par margin/P&L/exit fee ke hisaab se wallet update hota hai.

Entry/close wallet aur trade changes MongoDB transaction mein hote hain. Scanner ek scan mein har qualifying symbol ke liye entry ki koshish karta hai; available margin limits total positions, aur unique database index har symbol par ek hi open trade allow karta hai. Startup par purana account-wide index remove hota hai. Transactions ke liye MongoDB Atlas jaise replica-set environment ki zaroorat hoti hai.

Net-losing STOP_LOSS ke baad us symbol ko 3 configured candle intervals ka cooldown lagta hai—default 15m interval par 45 minute. Default do consecutive losing closed trades ek UTC day mein hone par nayi entries agle UTC day tak rukti hain. Alag daily realized-loss cap (default 400 USDT) bhi nayi entries rokta hai; existing trade monitoring band nahi karta. Consecutive-loss count persisted closed trades se calculate hota hai, isliye backend restart se breaker reset nahi hota.

## 6. Database/model aur API surfaces

### MongoDB models

- [`BotState.js`](./trading-bot-backend/src/models/BotState.js): ek primary bot enabled/paused state.
- [`VirtualWallet.js`](./trading-bot-backend/src/models/VirtualWallet.js): ek primary virtual account aur margin/P&L fields.
- [`PaperTrade.js`](./trading-bot-backend/src/models/PaperTrade.js): simulated position, prices, fees, P&L, close reason aur stop-loss analysis.

Trade records aur BotState MongoDB mein persist hote hain. `auditLog` engine process memory mein limited recent events rakhta hai, isliye use permanent audit archive na samjhein.

### Mukhya API

| Method | Path | Kaam |
|---|---|---|
| GET | `/api/health/live` | Process liveness |
| GET | `/api/health/ready` | MongoDB readiness aur engine state |
| GET | `/api/bot/status` | Bot, feed, risk config aur market errors |
| GET | `/api/bot/audit` | Recent in-memory events |
| GET | `/api/market/status` | Validated six-market snapshot |
| GET | `/api/market/:symbol/candles` | Configured symbol ki 500 finalized candles |
| GET | `/api/market/:symbol/indicators` | Indicators/votes |
| GET | `/api/market/:symbol/orderbook` | Binance top-20 book |
| GET | `/api/wallet`, `/api/trades` | Virtual wallet/trade history |
| POST | `/api/bot/start`, `/api/bot/stop` | New entries enable/pause |
| POST | `/api/trades/:id/close` | Authorized paper position close |

Control routes par backend token chahiye. Vercel control gateway exact dashboard origin validate karke sirf allowlisted start/stop/close actions forward karta hai aur token server-side rakhta hai. Dashboard ke browser code mein token hona nahi chahiye.

## 7. AI, alerts aur UI ka daayra

- [`trading-bot-backend/src/services/assistantProvider.js`](./trading-bot-backend/src/services/assistantProvider.js) Gemini se read-only voice response bana sakta hai. Isse sanitized snapshot aur user query di jaati hai; provider ko trades execute/modify karne ka adhikar nahi hai. Iske liye backend par Gemini config aur alag read-token setup chahiye.
- Agent context API read-only aur sanitized hai; ye control token/permissions ka substitute nahi.
- Frontend browser notifications user permission ke baad trade changes par chalti hain. Backend ntfy alerts best-effort hain; notification failure trade accounting ko nahi rokta.
- UI ke tabs: Home, Strategy, Brain Health, Wallet. Dashboard har 3 second par snapshot/audit poll karta hai.

## 8. Configuration aur run/deploy

Backend defaults aur bounds [`trading-bot-backend/src/config.js`](./trading-bot-backend/src/config.js) mein hain:

| Variable | Default/maqsad |
|---|---|
| `MONGODB_URI` | Required database connection |
| `BOT_CONTROL_TOKEN` | Private control auth token |
| `BOT_ENABLED` | Naya BotState bante waqt initial enabled state |
| `INITIAL_BALANCE_USDT` | Default `10000` virtual balance |
| `CANDLE_INTERVAL` | Default `15m` |
| `PAPER_LEVERAGE` | Default `1`, allowed `1–5` |
| `REWARD_RISK_RATIO` | Default `2`, allowed `1–10` |
| `DAILY_LOSS_LIMIT_USDT` | Default `400` |
| `DAILY_CONSECUTIVE_LOSS_LIMIT` | Default `2` consecutive closed losses per UTC day |
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

## 9. Jo yeh algorithm **nahi** karta

- Machine learning, AI prediction model ya trained strategy nahi: entry logic fixed deterministic thresholds hain.
- Formal backtest, out-of-sample validation, benchmark, win-rate/profitability proof ya future performance forecast nahi.
- Exchange par real buy/sell order, real account balance, real short borrowing, funding/borrow fee ya exchange order lifecycle nahi.
- Har indicator independent vote nahi: indicators correlated ho sakte hain aur fixed vote count probability/confidence score nahi hota.
- “1% risk” guarantee nahi; gap/fees/slippage/simulation assumptions se actual simulated loss alag ho sakta hai.

Isliye ise **market-data-driven paper-trading demo/strategy simulator** samjhein, verified profitable trading system ya financial advice nahi.

## 10. Repository mein kahan se verify karein

- Strategy aur sizing: [`strategy.js`](./trading-bot-backend/src/services/strategy.js)
- Scanner, gates, exits aur wallet accounting: [`paperTradingEngine.js`](./trading-bot-backend/src/services/paperTradingEngine.js)
- Binance bootstrap/streams: [`binanceFeed.js`](./trading-bot-backend/src/services/binanceFeed.js)
- API/auth: [`app.js`](./trading-bot-backend/src/app.js), [`controlAuth.js`](./trading-bot-backend/src/middleware/controlAuth.js), [`api/control/[...path].js`](./api/control/%5B...path%5D.js)
- Frontend data contract/UI: [`backendApi.ts`](./src/services/backendApi.ts), [`App.tsx`](./src/App.tsx)
- Backend automated tests: `trading-bot-backend/test/` (strategy, engine, feed, API, auth/rate-limit aur alerts coverage).
