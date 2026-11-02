const axios = require('axios');
const WebSocket = require('ws');
const { config, SYMBOLS } = require('../config');

const REQUIRED_CANDLES = 500;
const REQUIRED_BOOK_LEVELS = 50;
const BOOK_REFRESH_MS = 5_000;
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

class BinanceFeed {
  constructor({ onCandle, onPrice, onOrderBook, onFeedState, logger = console }) {
    this.onCandle = onCandle;
    this.onPrice = onPrice;
    this.onOrderBook = onOrderBook;
    this.onFeedState = onFeedState;
    this.logger = logger;
    this.socket = null;
    this.reconnectTimer = null;
    this.bookTimer = null;
    this.reconnectDelay = 1_000;
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
      response = await axios.get(`${config.binanceRestUrl}/api/v3/klines`, {
        params: { symbol, interval: config.candleInterval, limit: 501 },
        timeout: 10_000,
      });
    } catch (cause) {
      throw dataError(symbol, cause.message);
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

  async fetchOrderBook(symbol) {
    let response;
    try {
      response = await axios.get(`${config.binanceRestUrl}/api/v3/depth`, {
        params: { symbol, limit: 100 },
        timeout: 10_000,
      });
    } catch (cause) {
      const error = new Error(`ORDERBOOK_DISCONNECTED: Binance depth request failed for ${symbol}: ${cause.message}`);
      error.code = 'ORDERBOOK_DISCONNECTED';
      throw error;
    }

    const bids = response.data?.bids;
    const asks = response.data?.asks;
    if (!Array.isArray(bids) || !Array.isArray(asks)
      || bids.length < REQUIRED_BOOK_LEVELS || asks.length < REQUIRED_BOOK_LEVELS
      || !bids.slice(0, REQUIRED_BOOK_LEVELS).every((level) => Array.isArray(level) && level.length >= 2)
      || !asks.slice(0, REQUIRED_BOOK_LEVELS).every((level) => Array.isArray(level) && level.length >= 2)) {
      const error = new Error(`ORDERBOOK_DISCONNECTED: Binance returned fewer than ${REQUIRED_BOOK_LEVELS} bid/ask levels for ${symbol}`);
      error.code = 'ORDERBOOK_DISCONNECTED';
      throw error;
    }

    const parseLevels = (levels) => levels.slice(0, REQUIRED_BOOK_LEVELS).map(([price, quantity]) => ({
      price: Number(price),
      quantity: Number(quantity),
    }));
    const bidLevels = parseLevels(bids);
    const askLevels = parseLevels(asks);
    if (![...bidLevels, ...askLevels].every((level) =>
      Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.quantity) && level.quantity > 0)) {
      const error = new Error(`ORDERBOOK_DISCONNECTED: Binance returned invalid depth levels for ${symbol}`);
      error.code = 'ORDERBOOK_DISCONNECTED';
      throw error;
    }

    const bidQuantity = bidLevels.reduce((sum, level) => sum + level.quantity, 0);
    const askQuantity = askLevels.reduce((sum, level) => sum + level.quantity, 0);
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
      updatedAt: new Date(),
    };
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.synchronize();
  }

  async synchronize() {
    if (this.stopped || this.syncing) return;
    this.syncing = true;
    try {
      const markets = await Promise.all(SYMBOLS.map(async (symbol) => {
        try {
          const [candles, orderBook] = await Promise.all([
            this.fetchCandles(symbol),
            this.fetchOrderBook(symbol),
          ]);
          return { symbol, candles, orderBook };
        } catch (error) {
          this.markSymbolError(symbol, error);
          throw error;
        }
      }));

      for (const market of markets) {
        const current = this.data.get(market.symbol);
        current.candles = market.candles;
        current.orderBook = market.orderBook;
        current.error = null;
        current.orderBookError = null;
        this.data.set(market.symbol, current);
        await this.onCandle(market.symbol, market.candles, { historical: true });
        this.onOrderBook(market.symbol, market.orderBook);
        this.onFeedState(market.symbol, { error: null, orderBookError: null });
      }

      this.initialized = true;
      this.connect();
      this.startBookRefresh();
    } catch (error) {
      this.logger.error('Binance real market data synchronization failed', error);
      this.scheduleReconnect();
    } finally {
      this.syncing = false;
    }
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

  startBookRefresh() {
    if (this.bookTimer) clearInterval(this.bookTimer);
    this.bookTimer = setInterval(() => {
      Promise.all(SYMBOLS.map(async (symbol) => {
        try {
          const orderBook = await this.fetchOrderBook(symbol);
          const current = this.data.get(symbol);
          current.orderBook = orderBook;
          current.orderBookError = null;
          this.data.set(symbol, current);
          this.onOrderBook(symbol, orderBook);
          this.onFeedState(symbol, { orderBookError: null });
        } catch (error) {
          this.markSymbolError(symbol, error);
          this.logger.error('Binance order book unavailable', { symbol, error });
        }
      })).catch((error) => this.logger.error('Order book refresh failed', error));
    }, BOOK_REFRESH_MS);
    this.bookTimer.unref();
  }

  connect() {
    if (this.stopped) return;
    const streams = SYMBOLS.flatMap((symbol) => [
      `${symbol.toLowerCase()}@kline_${config.candleInterval}`,
      `${symbol.toLowerCase()}@trade`,
    ]).join('/');
    this.socket = new WebSocket(`${config.binanceWsUrl}?streams=${streams}`, { maxPayload: 1_048_576 });

    this.socket.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1_000;
      this.logger.info('Connected to Binance public trade and kline streams');
    });
    this.socket.on('message', (buffer) => {
      try {
        const payload = JSON.parse(buffer.toString());
        const event = payload.data || payload;
        if (event.e === 'trade') {
          const price = Number(event.p);
          if (Number.isFinite(price) && price > 0) {
            const current = this.data.get(event.s);
            if (current) {
              current.price = price;
              current.lastTradeAt = new Date(Number(event.T));
              this.data.set(event.s, current);
              this.onPrice(event.s, price, current.lastTradeAt);
            }
          }
          return;
        }
        if (event.e !== 'kline' || !event.k || !this.data.has(event.s)) return;
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
            const contiguous = current.candles.slice(1).every((item, index) =>
              current.candles[index].closeTime + 1 === item.openTime);
            current.error = current.candles.length === REQUIRED_CANDLES && contiguous
              ? null
              : dataError(event.s, current.candles.length !== REQUIRED_CANDLES
                ? 'closed candle history is incomplete'
                : 'closed candle history contains a time gap').message;
            this.data.set(event.s, current);
            this.onFeedState(event.s, { error: current.error });
            if (current.error && this.socket?.readyState === WebSocket.OPEN) {
              this.socket.close(4000, 'Closed candle history is incomplete');
            }
          })
          .catch((error) => {
            this.markSymbolError(event.s, error);
            this.logger.error('Candle processing failed', { symbol: event.s, error });
          });
      } catch (error) {
        this.logger.error('Unable to parse Binance market event', error);
      }
    });
    this.socket.on('error', (error) => this.logger.error('Binance WebSocket error', error));
    this.socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      for (const symbol of SYMBOLS) {
        const error = dataError(symbol, 'Binance WebSocket disconnected');
        this.markSymbolError(symbol, error);
      }
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.synchronize();
    }, delay);
    this.reconnectTimer.unref();
    this.logger.warn(`Binance feed unavailable; retrying real-data synchronization in ${delay}ms`);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.bookTimer) clearInterval(this.bookTimer);
    this.reconnectTimer = null;
    this.bookTimer = null;
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
