const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const { config, SYMBOLS } = require('../src/config');
const BinanceFeed = require('../src/services/binanceFeed');

function validDepthLevels(startPrice, descending) {
  return Array.from({ length: 20 }, (_, index) => [
    String(startPrice + (descending ? -index : index)),
    String(index + 1),
  ]);
}

function createFeed(callbacks = {}) {
  return new BinanceFeed({
    onCandle: callbacks.onCandle || (() => {}),
    onPrice: callbacks.onPrice || (() => {}),
    onOrderBook: callbacks.onOrderBook || (() => {}),
    onFeedState: callbacks.onFeedState || (() => {}),
    logger: callbacks.logger || { info() {}, warn() {}, error() {} },
  });
}

test('REST defaults to Binance data API and rejects trading API host fallbacks', () => {
  const backendDirectory = path.resolve(__dirname, '..');
  const defaultHost = spawnSync(process.execPath, [
    '-e',
    "process.stdout.write(require('./src/config').config.binanceRestUrl)",
  ], {
    cwd: backendDirectory,
    env: { ...process.env, BINANCE_REST_URL: '' },
    encoding: 'utf8',
  });
  assert.equal(defaultHost.status, 0, defaultHost.stderr);
  assert.equal(defaultHost.stdout, 'https://data-api.binance.vision');

  const forbiddenHost = spawnSync(process.execPath, [
    '-e',
    "require('./src/config')",
  ], {
    cwd: backendDirectory,
    env: { ...process.env, BINANCE_REST_URL: 'https://api.binance.com' },
    encoding: 'utf8',
  });
  assert.notEqual(forbiddenHost.status, 0);
  assert.match(forbiddenHost.stderr, /must use https:\/\/data-api\.binance\.vision/);
  assert.equal(BinanceFeed.BOOTSTRAP_SYMBOL_DELAY_MS, 2_000);
});

test('historical candles use the configured REST host and validate real closed history', async () => {
  const originalGet = axios.get;
  const originalUrl = config.binanceRestUrl;
  const originalInterval = config.candleInterval;
  const requested = [];
  config.binanceRestUrl = 'https://market-data.example/';
  config.candleInterval = '15m';
  axios.get = async (url, options) => {
    requested.push({ url, options });
    const intervalMs = options.params.interval === '5m' ? 300_000 : 900_000;
    const startTime = Date.now() - 502 * intervalMs;
    return {
      data: Array.from({ length: 501 }, (_, index) => {
        const openTime = startTime + index * intervalMs;
        return [openTime, '100', '101', '99', '100', '2', openTime + intervalMs - 1];
      }),
    };
  };

  try {
    const feed = createFeed();
    const history = await feed.fetchCandles(SYMBOLS[0], '15m');
    assert.equal(history.length, 500);
    assert.equal(requested[0].url, 'https://market-data.example/api/v3/klines');
    assert.deepEqual(requested[0].options.params, {
      symbol: SYMBOLS[0],
      interval: '15m',
      limit: 501,
    });
    const fiveMinuteHistory = await feed.fetchCandles(SYMBOLS[0], '5m');
    assert.equal(fiveMinuteHistory.length, 500);
    assert.equal(requested[1].options.params.interval, '5m');
  } finally {
    axios.get = originalGet;
    config.binanceRestUrl = originalUrl;
    config.candleInterval = originalInterval;
  }
});

test('historical bootstrap parses Binance IP-ban expiry when Retry-After is absent', async () => {
  const originalGet = axios.get;
  const originalUrl = config.binanceRestUrl;
  config.binanceRestUrl = 'https://market-data.example';
  const bannedUntil = Date.now() + 120_000;
  axios.get = async () => {
    const error = new Error('Request failed with status code 418');
    error.response = {
      status: 418,
      headers: {},
      data: { msg: `Way too much request weight used; IP banned until ${bannedUntil}` },
    };
    throw error;
  };

  try {
    const feed = createFeed();
    await assert.rejects(feed.fetchCandles(SYMBOLS[0]), (error) => {
      assert.equal(error.status, 418);
      assert.ok(error.retryAfterMs > 119_000 && error.retryAfterMs <= 120_000);
      return true;
    });
  } finally {
    axios.get = originalGet;
    config.binanceRestUrl = originalUrl;
  }
});

test('combined WebSocket URL subscribes both candle intervals, trade, and depth for all symbols', () => {
  const feed = createFeed();
  const url = new URL(feed.getStreamUrl());
  const streams = url.searchParams.get('streams').split('/');
  assert.equal(streams.length, SYMBOLS.length * (config.entryIntervals.length + 2));
  for (const symbol of SYMBOLS) {
    const normalized = symbol.toLowerCase();
    for (const interval of config.entryIntervals) {
      assert.ok(streams.includes(`${normalized}@kline_${interval}`));
    }
    assert.ok(streams.includes(`${normalized}@trade`));
    assert.ok(streams.includes(`${normalized}@depth20@1000ms`));
  }
});

test('WebSocket trade, depth, and closed-kline events update live feed state', async () => {
  const prices = [];
  const books = [];
  const candles = [];
  const feed = createFeed({
    onPrice: (symbol, price) => prices.push({ symbol, price }),
    onOrderBook: (symbol, orderBook) => books.push({ symbol, orderBook }),
    onCandle: async (symbol, update, options) => candles.push({ symbol, update, options }),
  });
  const symbol = SYMBOLS[0];
  const timestamp = Date.now();

  feed.handleMessage(Buffer.from(JSON.stringify({
    stream: `${symbol.toLowerCase()}@trade`,
    data: { e: 'trade', s: symbol, p: '123.45', T: timestamp },
  })));
  feed.handleMessage(Buffer.from(JSON.stringify({
    stream: `${symbol.toLowerCase()}@depth20@1000ms`,
    data: {
      e: 'depthUpdate',
      s: symbol,
      E: timestamp,
      b: validDepthLevels(123.4, true),
      a: validDepthLevels(123.5, false),
    },
  })));
  feed.handleMessage(Buffer.from(JSON.stringify({
    stream: `${symbol.toLowerCase()}@kline_${config.candleInterval}`,
    data: {
      e: 'kline',
      s: symbol,
      k: {
        t: timestamp - 900_000,
        T: timestamp - 1,
        o: '123',
        h: '124',
        l: '122',
        c: '123.45',
        v: '20',
        x: true,
      },
    },
  })));
  feed.handleMessage(Buffer.from(JSON.stringify({
    stream: `${symbol.toLowerCase()}@kline_5m`,
    data: {
      e: 'kline',
      s: symbol,
      k: {
        i: '5m',
        t: timestamp - 300_000,
        T: timestamp - 1,
        o: '123',
        h: '124',
        l: '122',
        c: '123.45',
        v: '20',
        x: true,
      },
    },
  })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(prices, [{ symbol, price: 123.45 }]);
  assert.equal(feed.data.get(symbol).price, 123.45);
  assert.equal(books.length, 1);
  assert.equal(books[0].orderBook.levelCount, 20);
  assert.equal(books[0].orderBook.bestBid, 123.4);
  assert.equal(books[0].orderBook.bestAsk, 123.5);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].options.final, true);
  assert.equal(candles[0].options.interval, config.candleInterval);
  assert.equal(candles[1].options.interval, '5m');
  assert.equal(feed.data.get(symbol).candles.length, 1);
  assert.equal(feed.intervalData.get('5m').get(symbol).candles.length, 1);
});

test('combined WebSocket partial-depth messages update the order book', () => {
  const books = [];
  const feedStates = [];
  const feed = createFeed({
    onOrderBook: (symbol, orderBook) => books.push({ symbol, orderBook }),
    onFeedState: (symbol, state) => feedStates.push({ symbol, state }),
  });
  const symbol = SYMBOLS[0];

  feed.handleMessage(Buffer.from(JSON.stringify({
    stream: `${symbol.toLowerCase()}@depth20@1000ms`,
    data: {
      lastUpdateId: 123,
      bids: validDepthLevels(123.4, true),
      asks: validDepthLevels(123.5, false),
    },
  })));

  assert.equal(books.length, 1);
  assert.equal(books[0].symbol, symbol);
  assert.equal(books[0].orderBook.levelCount, 20);
  assert.equal(books[0].orderBook.bestBid, 123.4);
  assert.equal(books[0].orderBook.bestAsk, 123.5);
  assert.equal(feed.data.get(symbol).orderBookError, null);
  assert.deepEqual(feedStates, [{ symbol, state: { orderBookError: null } }]);
});

test('418 pauses REST bootstrap until the ban expires, then restores history while WebSocket stays live', async () => {
  const originalFetchCandles = BinanceFeed.prototype.fetchCandles;
  let requests = 0;
  const loggedMessages = [];
  const intervalDurations = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
    '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
    '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
  };
  const histories = new Map(config.entryIntervals.map((interval) => {
    const intervalMs = intervalDurations[interval];
    const latestOpenTime = Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs;
    return [interval, Array.from({ length: BinanceFeed.REQUIRED_CANDLES }, (_, index) => {
      const openTime = latestOpenTime - (BinanceFeed.REQUIRED_CANDLES - index - 1) * intervalMs;
      return {
        time: new Date(openTime),
        openTime,
        closeTime: openTime + intervalMs - 1,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 2,
        isFinal: true,
      };
    })];
  }));
  const feed = createFeed({
    logger: {
      info() {},
      warn(message) { loggedMessages.push(message); },
      error(message) { loggedMessages.push(message); },
    },
  });
  feed.bootstrapDelay = 10;
  feed.bootstrapSymbolDelayMs = 0;
  feed.connect = () => {
    feed.connected = true;
  };
  BinanceFeed.prototype.fetchCandles = async function fetchRejectedHistory(_symbol, interval) {
    requests += 1;
    if (requests === 1) {
      const error = new Error('DATA_FEED_OFFLINE: Binance historical request rejected');
      error.code = 'DATA_FEED_OFFLINE';
      error.status = 418;
      error.retryAfterMs = 20;
      throw error;
    }
    return histories.get(interval);
  };

  try {
    await feed.start();
    assert.equal(requests, 1, 'do not make more REST requests during the IP ban');
    assert.equal(feed.connected, true);
    assert.equal(feed.initialized, false);
    assert.ok(feed.bootstrapTimer, 'schedule a retry for after the reported ban duration');
    assert.equal(feed.restIpBanned, true);
    assert.ok(loggedMessages.some((message) => message.includes('waiting for the ban to expire')));

    const retryWaitMs = 1_100
      + SYMBOLS.length * config.entryIntervals.length * BinanceFeed.REST_REQUEST_INTERVAL_MS;
    await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
    assert.ok(
      requests >= SYMBOLS.length * config.entryIntervals.length
        && requests <= SYMBOLS.length * config.entryIntervals.length + 1,
      'retry only the histories needed to finish bootstrapping both intervals',
    );
    assert.equal(feed.restIpBanned, false);
    assert.equal(feed.initialized, true);
    assert.equal(feed.bootstrapTimer, null);
    assert.ok(SYMBOLS.every((symbol) => feed.data.get(symbol).candles.length === 500));
    for (const interval of config.entryIntervals) {
      assert.ok(SYMBOLS.every((symbol) =>
        feed.intervalData.get(interval).get(symbol).candles.length === 500));
    }

    const symbol = SYMBOLS[0];
    feed.handleMessage(Buffer.from(JSON.stringify({
      stream: `${symbol.toLowerCase()}@trade`,
      data: { e: 'trade', s: symbol, p: '100', T: Date.now() },
    })));
    assert.equal(feed.data.get(symbol).price, 100, 'live stream continues during REST ban');
  } finally {
    feed.stop();
    BinanceFeed.prototype.fetchCandles = originalFetchCandles;
  }
});

test('REST bootstrap can be disabled before starting on an already-banned IP', async () => {
  const originalSetting = config.binanceRestBootstrapEnabled;
  const originalFetchCandles = BinanceFeed.prototype.fetchCandles;
  let requests = 0;
  const loggedMessages = [];
  config.binanceRestBootstrapEnabled = false;
  const feed = createFeed({
    logger: {
      info() {},
      warn(message) { loggedMessages.push(message); },
      error(message) { loggedMessages.push(message); },
    },
  });
  feed.connect = () => {
    feed.connected = true;
  };
  BinanceFeed.prototype.fetchCandles = async () => {
    requests += 1;
    throw new Error('REST bootstrap should remain disabled');
  };

  try {
    await feed.start();
    assert.equal(requests, 0);
    assert.equal(feed.connected, true);
    assert.equal(feed.restIpBanned, true);
    assert.ok(loggedMessages.includes(
      'Binance REST bootstrap disabled; accumulating candles from live WebSocket stream.',
    ));
  } finally {
    feed.stop();
    config.binanceRestBootstrapEnabled = originalSetting;
    BinanceFeed.prototype.fetchCandles = originalFetchCandles;
  }
});

test('live WebSocket candles accumulate verified history after REST bootstrap is unavailable', async () => {
  const candles = [];
  const feed = createFeed({
    onCandle: async (_symbol, updates) => candles.push(...updates),
  });
  const symbol = SYMBOLS[0];
  const intervalMs = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
    '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
    '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
  }[config.candleInterval];
  const latestOpenTime = Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs;

  for (let index = 0; index < BinanceFeed.REQUIRED_CANDLES; index += 1) {
    const openTime = latestOpenTime - (BinanceFeed.REQUIRED_CANDLES - index - 1) * intervalMs;
    feed.handleMessage(Buffer.from(JSON.stringify({
      stream: `${symbol.toLowerCase()}@kline_${config.candleInterval}`,
      data: {
        e: 'kline',
        s: symbol,
        k: {
          t: openTime,
          T: openTime + intervalMs - 1,
          o: '100',
          h: '101',
          l: '99',
          c: '100',
          v: '2',
          x: true,
        },
      },
    })));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(candles.length, BinanceFeed.REQUIRED_CANDLES);
  assert.equal(feed.data.get(symbol).candles.length, BinanceFeed.REQUIRED_CANDLES);
  assert.equal(feed.data.get(symbol).error, null);
});
