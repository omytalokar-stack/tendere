const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const { config, SYMBOLS } = require('../src/config');
const BinanceFeed = require('../src/services/binanceFeed');

function validDepthResponse() {
  const levels = Array.from({ length: 50 }, (_, index) => [
    String(100 - index),
    '2',
  ]);
  return { data: { bids: levels, asks: levels } };
}

test('candle and depth requests use the configured Binance host and are paced', async () => {
  const originalGet = axios.get;
  const originalUrl = config.binanceRestUrl;
  const requestTimes = [];
  const requestedUrls = [];
  config.binanceRestUrl = 'https://market-data.example/';
  const intervalMs = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
    '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
    '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
  }[config.candleInterval];
  const startTime = Date.now() - 502 * intervalMs;
  const candles = Array.from({ length: 501 }, (_, index) => {
    const openTime = startTime + index * intervalMs;
    return [openTime, '100', '101', '99', '100', '2', openTime + intervalMs - 1];
  });
  axios.get = async (url) => {
    requestTimes.push(Date.now());
    requestedUrls.push(url);
    return url.endsWith('/klines') ? { data: candles } : validDepthResponse();
  };

  try {
    const feed = new BinanceFeed({});
    const historicalCandles = await feed.fetchCandles(SYMBOLS[0]);
    assert.equal(historicalCandles.length, 500);
    await feed.fetchOrderBook(SYMBOLS[0]);

    assert.deepEqual(requestedUrls, [
      'https://market-data.example/api/v3/klines',
      'https://market-data.example/api/v3/depth',
    ]);
    assert.ok(
      requestTimes[1] - requestTimes[0] >= BinanceFeed.REST_REQUEST_INTERVAL_MS - 10,
      'REST calls should be separated by the configured request interval',
    );
  } finally {
    axios.get = originalGet;
    config.binanceRestUrl = originalUrl;
  }
});

test('HTTP 418 stops REST requests and respects Retry-After', async () => {
  const originalGet = axios.get;
  const originalUrl = config.binanceRestUrl;
  let requestCount = 0;
  config.binanceRestUrl = 'https://market-data.example';
  axios.get = async () => {
    requestCount += 1;
    const error = new Error('Request failed with status code 418');
    error.response = {
      status: 418,
      headers: { 'retry-after': '120' },
      data: { msg: 'IP banned until retry window' },
    };
    throw error;
  };

  try {
    const feed = new BinanceFeed({});
    await assert.rejects(feed.fetchOrderBook(SYMBOLS[0]), (error) => {
      assert.equal(error.code, 'ORDERBOOK_DISCONNECTED');
      assert.equal(error.status, 418);
      assert.equal(error.retryAfterMs, 120_000);
      assert.match(error.message, /IP banned until retry window/);
      return true;
    });
    await assert.rejects(feed.fetchOrderBook(SYMBOLS[1]), (error) => {
      assert.equal(error.status, 418);
      assert.ok(error.retryAfterMs > 0);
      return true;
    });
    assert.equal(requestCount, 1, 'requests should remain paused during the ban window');
  } finally {
    axios.get = originalGet;
    config.binanceRestUrl = originalUrl;
  }
});
