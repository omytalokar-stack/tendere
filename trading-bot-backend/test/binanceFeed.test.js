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
  const intervalMs = 900_000;
  const startTime = Date.now() - 502 * intervalMs;
  const candles = Array.from({ length: 501 }, (_, index) => {
    const openTime = startTime + index * intervalMs;
    return [openTime, '100', '101', '99', '100', '2', openTime + intervalMs - 1];
  });
  axios.get = async (url, options) => {
    requested.push({ url, options });
    return { data: candles };
  };

  try {
    const feed = createFeed();
    const history = await feed.fetchCandles(SYMBOLS[0]);
    assert.equal(history.length, 500);
    assert.equal(requested[0].url, 'https://market-data.example/api/v3/klines');
    assert.deepEqual(requested[0].options.params, {
      symbol: SYMBOLS[0],
      interval: '15m',
      limit: 501,
    });
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

test('combined WebSocket URL subscribes all six symbols to kline, trade, and depth streams', () => {
  const feed = createFeed();
  const url = new URL(feed.getStreamUrl());
  const streams = url.searchParams.get('streams').split('/');
  assert.equal(streams.length, SYMBOLS.length * 3);
  for (const symbol of SYMBOLS) {
    const normalized = symbol.toLowerCase();
    assert.ok(streams.includes(`${normalized}@kline_${config.candleInterval}`));
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
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(prices, [{ symbol, price: 123.45 }]);
  assert.equal(feed.data.get(symbol).price, 123.45);
  assert.equal(books.length, 1);
  assert.equal(books[0].orderBook.levelCount, 20);
  assert.equal(books[0].orderBook.bestBid, 123.4);
  assert.equal(books[0].orderBook.bestAsk, 123.5);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].options.final, true);
  assert.equal(feed.data.get(symbol).candles.length, 1);
});

test('418 stops all REST bootstrap requests while keeping WebSocket live', async () => {
  const originalFetchCandles = BinanceFeed.prototype.fetchCandles;
  let requests = 0;
  const loggedMessages = [];
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
  BinanceFeed.prototype.fetchCandles = async function fetchRejectedHistory() {
    requests += 1;
    const error = new Error('DATA_FEED_OFFLINE: Binance historical request rejected');
    error.code = 'DATA_FEED_OFFLINE';
    error.status = 418;
    error.retryAfterMs = 60_000;
    throw error;
  };

  try {
    await feed.start();
    assert.equal(requests, 1, 'stop bootstrap requests immediately on an IP-ban response');
    assert.equal(feed.connected, true);
    assert.equal(feed.initialized, false);
    assert.equal(feed.bootstrapTimer, null);
    assert.equal(feed.restIpBanned, true);
    await feed.bootstrapHistory();
    assert.equal(requests, 1, 'a banned feed must never retry historical REST requests');
    assert.ok(loggedMessages.includes('REST IP banned; accumulating candles from live WebSocket stream.'));

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
