const test = require('node:test');
const assert = require('node:assert/strict');
const {
  notifyTradeOpened,
  notifyTradeClosed,
  notifyDailyLossLimit,
} = require('../src/services/notificationAlerts');
const PaperTradingEngine = require('../src/services/paperTradingEngine');
const { config } = require('../src/config');

test('config exports the configured ntfy topic or the private fallback topic', () => {
  assert.equal(config.ntfyTopic, process.env.NTFY_TOPIC || 'auraalgo_live_897k3_rajesh');
});

async function withMockedFetch(run) {
  const originalFetch = global.fetch;
  const originalTopic = process.env.NTFY_TOPIC;
  const originalNodeEnv = process.env.NODE_ENV;
  const requests = [];
  process.env.NTFY_TOPIC = 'test_topic_123';
  process.env.NODE_ENV = 'production';
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200 };
  };
  try {
    await run(requests);
  } finally {
    global.fetch = originalFetch;
    if (originalTopic === undefined) delete process.env.NTFY_TOPIC;
    else process.env.NTFY_TOPIC = originalTopic;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

test('ntfy alerts include the expected trade event details and topic', async () => {
  await withMockedFetch(async (requests) => {
    const logger = { warn() {} };
    await notifyTradeOpened({
      symbol: 'ETHUSDT',
      side: 'LONG',
      entryPrice: 3_000,
      stopLoss: 2_900,
      takeProfit: 3_200,
    }, logger);
    await notifyTradeClosed({
      symbol: 'ETHUSDT',
      exitPrice: 3_200,
      pnlUsd: 12.34,
      closeReason: 'TAKE_PROFIT',
    }, logger);
    await notifyDailyLossLimit(400, logger);

    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, 'https://ntfy.sh/test_topic_123');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.Title, 'AuraAlgo: New Trade');
    assert.match(requests[0].options.body, /Symbol: ETHUSDT/);
    assert.match(requests[0].options.body, /Direction: LONG/);
    assert.match(requests[0].options.body, /Entry Price: 3,000 USDT/);
    assert.match(requests[0].options.body, /Stop Loss: 2,900 USDT/);
    assert.match(requests[0].options.body, /Target: 3,200 USDT/);
    assert.equal(requests[1].options.headers.Title, 'AuraAlgo: Trade Closed');
    assert.match(requests[1].options.body, /Exit Price: 3,200 USDT/);
    assert.match(requests[1].options.body, /Realized PnL: \+12\.34 USDT/);
    assert.match(requests[1].options.body, /Exit Reason: TAKE_PROFIT/);
    assert.equal(requests[2].options.headers.Title, 'AuraAlgo: Daily Loss Limit Reached');
    assert.match(requests[2].options.body, /400 USDT/);
  });
});

test('ntfy delivery failures are logged and swallowed', async () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const warnings = [];
  process.env.NODE_ENV = 'production';
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.doesNotReject(notifyTradeOpened({
      symbol: 'ETHUSDT',
      side: 'LONG',
      entryPrice: 3_000,
      stopLoss: 2_900,
      takeProfit: 3_200,
    }, { warn: (...args) => warnings.push(args) }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][1].error, /HTTP 503/);
  } finally {
    global.fetch = originalFetch;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('ntfy alerts never call fetch in the test environment', async () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  let fetchCalls = 0;
  process.env.NODE_ENV = 'test';
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200 };
  };
  try {
    await notifyTradeOpened({
      symbol: 'ETHUSDT',
      side: 'LONG',
      entryPrice: 3_000,
      stopLoss: 2_900,
      takeProfit: 3_200,
    });
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('missing or invalid trade prices use the Market Quote fallback', async () => {
  await withMockedFetch(async (requests) => {
    await notifyTradeOpened({
      symbol: 'ETHUSDT',
      side: 'LONG',
      entryPrice: undefined,
      stopLoss: 'invalid',
      takeProfit: 0,
    }, { warn() {} });
    assert.match(requests[0].options.body, /Entry Price: Market Quote/);
    assert.match(requests[0].options.body, /Stop Loss: Market Quote/);
    assert.match(requests[0].options.body, /Target: Market Quote/);
  });
});

test('daily loss circuit-breaker notification is sent at most once per UTC day per process', async () => {
  await withMockedFetch(async (requests) => {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    engine.sendDailyLossAlertOnce();
    engine.sendDailyLossAlertOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.match(requests[0].options.body, new RegExp(`${config.dailyLossLimit} USDT`));
  });
});
