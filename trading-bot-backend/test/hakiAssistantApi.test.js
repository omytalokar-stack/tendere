const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AI_READ_API_TOKEN = 'test-haki-key';
const createApp = require('../src/app');
const { config } = require('../src/config');
const VirtualWallet = require('../src/models/VirtualWallet');
const PaperTrade = require('../src/models/PaperTrade');

test('Haki query validates input and fails closed when no existing AI provider is configured', async (t) => {
  const engine = {
    async status() {
      throw new Error('Assistant route must not query app state without a configured provider');
    },
  };
  const server = createApp(engine).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const missingToken = await fetch(`${baseUrl}/assistant/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'hello' }),
  });
  assert.equal(missingToken.status, 401);

  const invalidToken = await fetch(`${baseUrl}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer invalid-token',
    },
    body: JSON.stringify({ query: 'hello' }),
  });
  assert.equal(invalidToken.status, 401);
  assert.equal(JSON.stringify(await invalidToken.json()).includes('invalid-token'), false);

  const invalidQuery = await fetch(`${baseUrl}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-haki-key',
    },
    body: JSON.stringify({ query: '' }),
  });
  assert.equal(invalidQuery.status, 400);

  const oversizedQuery = await fetch(`${baseUrl}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-haki-key',
    },
    body: JSON.stringify({ query: 'x'.repeat(1001) }),
  });
  assert.equal(oversizedQuery.status, 400);

  const malformedJson = await fetch(`${baseUrl}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-haki-key',
    },
    body: '{"query":',
  });
  assert.equal(malformedJson.status, 400);
  assert.deepEqual(await malformedJson.json(), { error: 'Invalid JSON request body' });

  const oversizedBody = await fetch(`${baseUrl}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-haki-key',
    },
    body: JSON.stringify({ query: 'x'.repeat(20_000) }),
  });
  assert.equal(oversizedBody.status, 413);
  assert.deepEqual(await oversizedBody.json(), { error: 'Request body is too large' });

  const validToken = await fetch(`${baseUrl}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-haki-key',
    },
    body: JSON.stringify({ query: 'What is my wallet balance?' }),
  });
  assert.equal(validToken.status, 503);
  assert.deepEqual(await validToken.json(), {
    error: 'Gemini AI is not configured',
    code: 'AI_PROVIDER_NOT_CONFIGURED',
    missingConfiguration: 'GEMINI_API_KEY',
  });
});

test('configured Haki query returns a non-empty response through the provider contract', async (t) => {
  const originalFindById = VirtualWallet.findById;
  const originalFind = PaperTrade.find;
  const originalApiKey = config.geminiApiKey;
  config.geminiApiKey = 'test-gemini-key';
  VirtualWallet.findById = () => ({
    lean: async () => ({
      balance: 1234,
      availableMargin: 1100,
      inTradeMargin: 134,
      totalRealizedPnl: 25,
      winCount: 2,
      lossCount: 1,
    }),
  });
  PaperTrade.find = () => ({
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => [],
  });
  t.after(() => {
    VirtualWallet.findById = originalFindById;
    PaperTrade.find = originalFind;
    config.geminiApiKey = originalApiKey;
  });

  let observedQuery;
  let observedSnapshot;
  const engine = {
    async status() {
      return {
        running: true,
        enabled: true,
        feedConnected: true,
        marketDataReady: true,
        interval: '15m',
        entryIntervals: ['5m', '15m'],
      };
    },
    getMarketSnapshot(symbol) {
      return { symbol, price: 2500, ready: true };
    },
  };
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (message) => loggedErrors.push(message);
  t.after(() => {
    console.error = originalConsoleError;
  });
  const server = createApp(engine, {
    assistantGenerator: async (query, snapshot) => {
      if (query === 'test provider failure') {
        throw new Error('test-gemini-key must never be logged or returned');
      }
      observedQuery = query;
      observedSnapshot = snapshot;
      return 'आपके पेपर वॉलेट में 1,234 USDT हैं।';
    },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-haki-key',
    },
    body: JSON.stringify({ query: 'मेरा wallet balance बताइए' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    response: 'आपके पेपर वॉलेट में 1,234 USDT हैं।',
  });
  assert.equal(observedQuery, 'मेरा wallet balance बताइए');
  assert.equal(observedSnapshot.wallet.balance, 1234);

  const providerFailure = await fetch(`http://127.0.0.1:${server.address().port}/assistant/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-haki-key',
    },
    body: JSON.stringify({ query: 'test provider failure' }),
  });
  assert.equal(providerFailure.status, 502);
  const failureBody = await providerFailure.json();
  assert.deepEqual(failureBody, { error: 'Assistant provider request failed' });
  assert.equal(JSON.stringify(failureBody).includes('test-gemini-key'), false);
  assert.equal(loggedErrors.some((message) => String(message).includes('test-gemini-key')), false);
});
