const axios = require('axios');
const WebSocket = require('ws');
const { config, SYMBOLS } = require('../config');

const REQUIRED_CANDLES = 500;
const REQUIRED_BOOK_LEVELS = 20;
const BOOTSTRAP_SYMBOL_DELAY_MS = 500;
const REST_REQUEST_INTERVAL_MS = 150;
const DEFAULT_BAN_COOLDOWN_MS = 5 * 60_000;
let restRequestQueue = Promise.resolve();
let lastRestRequestAt = 0;
let restBlockedUntil = 0;
const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

function dataError(symbol, detail) {
  const error = new Error(`DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: ${detail}`);
  error.code = 'DATA_FEED_OFFLINE';
  return error;
}

function retryAfterMs(cause) {
  const retryAfter = cause.response?.headers?.['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  const banExpiry = String(cause.response?.data?.msg || '').match(/banned until\s+(\d{10,13})/i);
  if (banExpiry) {
    const rawTimestamp = Number(banExpiry[1]);
    const expiryMs = banExpiry[1].length === 10 ? rawTimestamp * 1_000 : rawTimestamp;
    if (Number.isFinite(expiryMs)) return Math.max(0, expiryMs - Date.now());
  }
  return cause.response?.status === 418 ? DEFAULT_BAN_COOLDOWN_MS : 0;
}

function requestRest(url, options) {
  const request = restRequestQueue.then(async () => {
    if (Date.now() < restBlockedUntil) {
      const error = new Error('Binance REST requests are paused after a rate-limit response');
      error.response = { status: 418 };
      error.retryAfterMs = restBlockedUntil - Date.now();
      throw error;
    }
    const elapsed = Date.now() - lastRestRequestAt;
    if (lastRestRequestAt && elapsed < REST_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, REST_REQUEST_INTERVAL_MS - elapsed));
    }
    lastRestRequestAt = Date.now();
    try {
      return await axios.get(url, options);
    } catch (error) {
      if (error.response?.status === 418) {
        const cooldown = error.retryAfterMs || retryAfterMs(error);
        restBlockedUntil = Math.max(restBlockedUntil, Date.now() + cooldown);
        error.retryAfterMs = cooldown;
      }
      throw error;
    }
  });
  restRequestQueue = request.then(() => undefined, () => undefined);
  return request;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function binanceRestUrl(path) {
  return `${config.binanceRestUrl.replace(/\/+$/, '')}${path}`;
}

function normalizeDepth(symbol, bids, asks, updatedAt = new Date()) {
  if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.getTime())) {
    const error = new Error(`ORDERBOOK_DISCONNECTED: Binance stream returned an invalid depth timestamp for ${symbol}`);
    error.code = 'ORDERBOOK_DISCONNECTED';
    error.symbol = symbol;
    throw error;
  }
  if (!Array.isArray(bids) || !Array.isArray(asks)
    || bids.length < REQUIRED_BOOK_LEVELS || asks.length < REQUIRED_BOOK_LEVELS
    || !bids.slice(0, REQUIRED_BOOK_LEVELS).every((level) => Array.isArray(level) && level.length >= 2)
    || !asks.slice(0, REQUIRED_BOOK_LEVELS).every((level) => Array.isArray(level) && level.length >= 2)) {
    const error = new Error(`ORDERBOOK_DISCONNECTED: Binance stream returned fewer than ${REQUIRED_BOOK_LEVELS} bid/ask levels for ${symbol}`);
    error.code = 'ORDERBOOK_DISCONNECTED';
    error.symbol = symbol;
    throw error;
  }

  const parseLevels = (levels) => levels.slice(0, REQUIRED_BOOK_LEVELS).map(([price, quantity]) => ({
    price: Number(price),
    quantity: Number(quantity),
  }));
  const bidLevels = parseLevels(bids);
  const askLevels = parseLevels(asks);
  if (![...bidLevels, ...askLevels].every((level) =>
    Number.isFinite(level.price) && level.price > 0
      && Number.isFinite(level.quantity) && level.quantity >= 0)) {
    const error = new Error(`ORDERBOOK_DISCONNECTED: Binance stream returned invalid depth levels for ${symbol}`);
    error.code = 'ORDERBOOK_DISCONNECTED';
    error.symbol = symbol;
    throw error;
  }

  const bidQuantity = bidLevels.reduce((sum, level) => sum + level.quantity, 0);
  const askQuantity = askLevels.reduce((sum, level) => sum + level.quantity, 0);
  if (bidQuantity + askQuantity <= 0) {
    const error = new Error(`ORDERBOOK_DISCONNECTED: Binance stream returned an empty depth book for ${symbol}`);
    error.code = 'ORDERBOOK_DISCONNECTED';
    error.symbol = symbol;
    throw error;
  }
  const bidNotional = bidLevels.reduce((sum, level) => sum + level.price * level.quantity, 0);
  const askNotional = askLevels.reduce((sum, level) => sum + level.price * level.quantity, 0);

  return {
    symbol,
    bids: bidLevels,
    asks: askLevels,
    bestBid: bidLevels[0].price,
    bestAsk: askLevels[0].price,
    bidQuantity,
    askQuantity,
    bidNotional,
    askNotional,
    levelCount: REQUIRED_BOOK_LEVELS,
    updatedAt,
  };
}

class BinanceFeed {
  constructor({ onCandle, onPrice, onOrderBook, onFeedState, logger = console }) {
    this.onCandle = onCandle;
    this.onPrice = onPrice;
    this.onOrderBook = onOrderBook;
    this.onFeedState = onFeedState;
    this.logger = logger;
    this.socket = null;
    this.reconnectTimer = null;
    this.bootstrapTimer = null;
    this.reconnectDelay = 1_000;
    this.bootstrapDelay = 5_000;
    this.stopped = true;
    this.initialized = false;
    this.syncing = false;
    this.connected = false;
    this.data = new Map(SYMBOLS.map((symbol) => [symbol, {
      candles: [],
      orderBook: null,
      price: null,
      lastTradeAt: null,
      error: `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: awaiting initial synchronization`,
      orderBookError: 'ORDERBOOK_DISCONNECTED',
    }]));
  }

  async fetchCandles(symbol) {
    let response;
    try {
      response = await requestRest(binanceRestUrl('/api/v3/klines'), {
        params: { symbol, interval: config.candleInterval, limit: 501 },
        timeout: 10_000,
      });
    } catch (cause) {
      const detail = cause.response?.data?.msg || cause.message;
      const error = dataError(symbol, `HTTP ${cause.response?.status || 'request'}: ${detail}`);
      error.status = cause.response?.status;
      error.retryAfterMs = cause.retryAfterMs || retryAfterMs(cause);
      throw error;
    }

    if (!Array.isArray(response.data)) throw dataError(symbol, 'invalid kline response');
    const closed = response.data.filter((row) => Array.isArray(row) && row.length >= 7).map((row) => ({
      time: new Date(Number(row[0])),
      openTime: Number(row[0]),
      closeTime: Number(row[6]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      isFinal: Number(row[6]) < Date.now(),
    })).filter((candle) => candle.isFinal
      && [candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
        .every(Number.isFinite)
      && candle.open > 0
      && candle.high > 0
      && candle.low > 0
      && candle.close > 0
      && candle.volume >= 0);

    if (closed.length < 250) {
      const error = new Error(`INSUFFICIENT_HISTORICAL_DATA: Binance returned ${closed.length} valid closed candles for ${symbol}; at least 250 are required`);
      error.code = 'INSUFFICIENT_HISTORICAL_DATA';
      throw error;
    }
    if (closed.length < REQUIRED_CANDLES) {
      throw dataError(symbol, `expected ${REQUIRED_CANDLES} completed candles, received ${closed.length}`);
    }
    const exactHistory = closed.slice(-REQUIRED_CANDLES);
    if (new Set(exactHistory.map((candle) => candle.openTime)).size !== REQUIRED_CANDLES) {
      throw dataError(symbol, 'completed candle timestamps are not unique');
    }
    const intervalMs = INTERVAL_MS[config.candleInterval];
    if (!exactHistory.slice(1).every((candle, index) =>
      candle.openTime - exactHistory[index].openTime === intervalMs)) {
      throw dataError(symbol, 'completed candle history contains a time gap');
    }
    return exactHistory;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    await this.bootstrapHistory();
  }

  async bootstrapHistory() {
    if (this.stopped || this.syncing) return;
    this.syncing = true;
    let rateLimitedError = null;
    try {
      for (let index = 0; index < SYMBOLS.length; index += 1) {
        const symbol = SYMBOLS[index];
        const current = this.data.get(symbol);
        if (this.getHistoryError(symbol, current.candles) === null) continue;

        try {
          const history = await this.fetchCandles(symbol);
          const liveCandles = current.candles.filter((candle) => candle.isFinal);
          const candlesByOpenTime = new Map(history.map((candle) => [candle.openTime, candle]));
          for (const candle of liveCandles) candlesByOpenTime.set(candle.openTime, candle);
          current.candles = [...candlesByOpenTime.values()]
            .sort((left, right) => left.openTime - right.openTime)
            .slice(-REQUIRED_CANDLES);
          current.error = this.getHistoryError(symbol, current.candles);
          this.data.set(symbol, current);
          await this.onCandle(symbol, current.candles, { historical: true });
          this.onFeedState(symbol, { error: current.error });
        } catch (error) {
          this.markSymbolError(symbol, error);
          this.logger.error('Binance historical candle bootstrap failed', { symbol, error });
          if (error.status === 418) {
            rateLimitedError = error;
            break;
          }
        }

        if (index < SYMBOLS.length - 1) await wait(BOOTSTRAP_SYMBOL_DELAY_MS);
      }

      this.initialized = SYMBOLS.every((symbol) =>
        this.getHistoryError(symbol, this.data.get(symbol).candles) === null);
      if (rateLimitedError) {
        this.scheduleBootstrapRetry(rateLimitedError);
      } else if (!this.initialized) {
        this.scheduleBootstrapRetry();
      } else {
        this.bootstrapDelay = 5_000;
        this.logger.info('Binance historical candle bootstrap complete');
      }
    } finally {
      this.syncing = false;
    }
  }

  getHistoryError(symbol, candles) {
    const contiguous = candles.slice(1).every((item, index) =>
      candles[index].closeTime + 1 === item.openTime);
    if (candles.length !== REQUIRED_CANDLES) {
      return dataError(symbol, `expected ${REQUIRED_CANDLES} completed candles, received ${candles.length}`).message;
    }
    if (!contiguous) {
      return dataError(symbol, 'completed candle history contains a time gap').message;
    }
    return null;
  }

  markSymbolError(symbol, error) {
    const current = this.data.get(symbol);
    if (!current) return;
    if (error.code === 'ORDERBOOK_DISCONNECTED') {
      current.orderBookError = error.message;
    } else {
      current.error = error.message;
    }
    this.data.set(symbol, current);
    this.onFeedState(symbol, {
      error: current.error,
      orderBookError: current.orderBookError,
    });
  }

  getStreamUrl() {
    const streams = SYMBOLS.flatMap((symbol) => [
      `${symbol.toLowerCase()}@kline_${config.candleInterval}`,
      `${symbol.toLowerCase()}@trade`,
      `${symbol.toLowerCase()}@depth20@1000ms`,
    ]).join('/');
    const baseUrl = config.binanceWsUrl.replace(/\/+$/, '');
    return `${baseUrl}?streams=${streams}`;
  }

  connect() {
    if (this.stopped || this.socket) return;
    this.socket = new WebSocket(this.getStreamUrl(), { maxPayload: 1_048_576 });

    this.socket.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1_000;
      this.logger.info('Connected to Binance combined trade, kline, and depth streams');
    });
    this.socket.on('message', (buffer) => this.handleMessage(buffer));
    this.socket.on('error', (error) => this.logger.error('Binance WebSocket error', error));
    this.socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      for (const symbol of SYMBOLS) {
        const error = dataError(symbol, 'Binance WebSocket disconnected');
        this.markSymbolError(symbol, error);
        const current = this.data.get(symbol);
        current.orderBookError = 'ORDERBOOK_DISCONNECTED: Binance WebSocket disconnected';
        this.data.set(symbol, current);
        this.onFeedState(symbol, { orderBookError: current.orderBookError });
      }
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  handleMessage(buffer) {
    try {
      const payload = JSON.parse(buffer.toString());
      const event = payload.data || payload;
      if (!event || !this.data.has(event.s)) return;

      if (event.e === 'trade') {
        const price = Number(event.p);
        const timestamp = Number(event.T);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
          throw dataError(event.s, 'invalid trade stream event');
        }
        const current = this.data.get(event.s);
        current.price = price;
        current.lastTradeAt = new Date(timestamp);
        this.data.set(event.s, current);
        this.onPrice(event.s, price, current.lastTradeAt);
        return;
      }

      if (event.e === 'depthUpdate') {
        const orderBook = normalizeDepth(
          event.s,
          event.b,
          event.a,
          event.E === undefined ? new Date() : new Date(Number(event.E)),
        );
        const current = this.data.get(event.s);
        current.orderBook = orderBook;
        current.orderBookError = null;
        this.data.set(event.s, current);
        this.onOrderBook(event.s, orderBook);
        this.onFeedState(event.s, { orderBookError: null });
        return;
      }

      if (event.e !== 'kline' || !event.k) return;
      const candle = {
        time: new Date(Number(event.k.t)),
        openTime: Number(event.k.t),
        closeTime: Number(event.k.T),
        open: Number(event.k.o),
        high: Number(event.k.h),
        low: Number(event.k.l),
        close: Number(event.k.c),
        volume: Number(event.k.v),
        isFinal: Boolean(event.k.x),
      };
      if (![candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
        .every(Number.isFinite)
        || candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) {
        throw dataError(event.s, 'invalid kline event');
      }
      Promise.resolve(this.onCandle(event.s, [candle], {
        historical: false,
        final: candle.isFinal,
        triggerOnly: !candle.isFinal,
      }))
        .then(() => {
          if (!candle.isFinal) return;
          const current = this.data.get(event.s);
          current.candles = [...current.candles.filter((item) => item.openTime !== candle.openTime), candle]
            .sort((left, right) => left.openTime - right.openTime)
            .slice(-REQUIRED_CANDLES);
          current.error = this.getHistoryError(event.s, current.candles);
          this.data.set(event.s, current);
          this.onFeedState(event.s, { error: current.error });
        })
        .catch((error) => {
          this.markSymbolError(event.s, error);
          this.logger.error('Candle processing failed', { symbol: event.s, error });
        });
    } catch (error) {
      if (error.code === 'ORDERBOOK_DISCONNECTED') {
        this.markSymbolError(error.symbol, error);
      }
      this.logger.error('Unable to process Binance market stream event', error);
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
    this.logger.warn(`Binance WebSocket disconnected; reconnecting in ${delay}ms`);
  }

  scheduleBootstrapRetry(error) {
    if (this.stopped || this.bootstrapTimer) return;
    const delay = Math.max(this.bootstrapDelay, error?.retryAfterMs || 0);
    this.bootstrapDelay = Math.min(this.bootstrapDelay * 2, 30 * 60_000);
    this.bootstrapTimer = setTimeout(() => {
      this.bootstrapTimer = null;
      this.bootstrapHistory().catch((bootstrapError) =>
        this.logger.error('Binance candle bootstrap retry failed', bootstrapError));
    }, delay);
    this.bootstrapTimer.unref();
    this.logger.warn(`Historical candle bootstrap incomplete; keeping WebSocket data live and retrying REST bootstrap in ${delay}ms`);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    this.reconnectTimer = null;
    this.bootstrapTimer = null;
    this.connected = false;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      socket.close();
    }
  }
}

module.exports = BinanceFeed;
module.exports.REQUIRED_CANDLES = REQUIRED_CANDLES;
module.exports.REQUIRED_BOOK_LEVELS = REQUIRED_BOOK_LEVELS;
module.exports.BOOTSTRAP_SYMBOL_DELAY_MS = BOOTSTRAP_SYMBOL_DELAY_MS;
module.exports.REST_REQUEST_INTERVAL_MS = REST_REQUEST_INTERVAL_MS;
module.exports.normalizeDepth = normalizeDepth;
