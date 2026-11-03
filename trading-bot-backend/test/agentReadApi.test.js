const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AI_READ_API_TOKEN = 'test-agent-read-token';
const createApp = require('../src/app');
const { config } = require('../src/config');
const VirtualWallet = require('../src/models/VirtualWallet');
const PaperTrade = require('../src/models/PaperTrade');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('agent context authenticates and returns only a sanitized read-only snapshot', async (t) => {
  const originalFindById = VirtualWallet.findById;
  const originalFind = PaperTrade.find;
  const originalToken = config.agentReadToken;
  VirtualWallet.findById = () => ({
    lean: async () => ({
      balance: 10000,
      availableMargin: 9000,
      inTradeMargin: 1000,
      totalRealizedPnl: 25,
      winCount: 2,
      lossCount: 1,
      privateCredential: 'must-not-leak',
      tenantId: 'private-tenant',
    }),
  });
  PaperTrade.find = () => ({
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => [{
      _id: 'trade-1',
      status: 'OPEN',
      symbol: 'ETHUSDT',
      side: 'LONG',
      entryPrice: 2500,
      privateCredential: 'must-not-leak',
      userId: 'private-user',
      apiToken: 'must-not-leak',
    }],
  });
  t.after(() => {
    VirtualWallet.findById = originalFindById;
    PaperTrade.find = originalFind;
    config.agentReadToken = originalToken;
  });

  const engine = {
    async status() {
      return {
        running: true,
        enabled: true,
        feedConnected: true,
        marketDataReady: true,
        symbols: ['ETHUSDT'],
        prices: { ETHUSDT: 2500 },
        privateCredential: 'must-not-leak',
        marketErrors: { ETHUSDT: 'private diagnostic data' },
      };
    },
    getMarketSnapshot(symbol) {
      return {
        symbol,
        price: 2500,
        priceSource: 'TRADE',
        lastTradeAt: '2026-01-01T00:00:00.000Z',
        marketAgeMs: 200,
        candles: Array(500),
        ready: true,
        candleError: null,
        orderBookError: null,
      };
    },
  };
  const server = await startServer(createApp(engine));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const unauthorized = await fetch(`${baseUrl}/api/agent/context`);
  assert.equal(unauthorized.status, 401);
  const invalidToken = await fetch(`${baseUrl}/api/agent/context`, {
    headers: { Authorization: 'Bearer invalid-token' },
  });
  assert.equal(invalidToken.status, 401);

  const response = await fetch(`${baseUrl}/api/agent/context`, {
    headers: { Authorization: 'Bearer test-agent-read-token' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const context = await response.json();
  assert.equal(context.webappName, 'AuraAlgo Crypto Paper Trading');
  assert.equal(context.apiBasePath, '/api/agent/context');
  assert.equal(context.pollingIntervalSeconds, 15);
  assert.equal(context.wallet.balance, 10000);
  assert.equal(context.trades[0].status, 'OPEN');
  assert.equal(context.trades[0].entryPrice, 2500);
  assert.equal(context.markets[0].price, 2500);
  assert.equal(context.bot.marketDataReady, true);
  assert.equal(JSON.stringify(context).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(context).includes('private-tenant'), false);
  assert.equal(JSON.stringify(context).includes('private-user'), false);
  assert.equal(JSON.stringify(context).includes('marketErrors'), false);

  const forbiddenMethod = await fetch(`${baseUrl}/api/agent/context`, { method: 'POST' });
  assert.equal(forbiddenMethod.status, 404);

  config.agentReadToken = undefined;
  const unconfigured = await fetch(`${baseUrl}/api/agent/context`);
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), {
    error: 'AI read API is not configured',
    code: 'AI_READ_API_NOT_CONFIGURED',
  });
});
