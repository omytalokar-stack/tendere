const test = require('node:test');
const assert = require('node:assert/strict');

async function loadGateway() {
  return import('../../api/control/[...path].js');
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
}

test('control gateway forwards only the allowlisted action with the server-side token', async () => {
  const { default: handler } = await loadGateway();
  const originalEnvironment = {
    dashboardOrigin: process.env.CONTROL_DASHBOARD_ORIGIN,
    backendUrl: process.env.PAPER_TRADING_API_URL,
    token: process.env.BOT_CONTROL_TOKEN,
  };
  const originalFetch = global.fetch;
  process.env.CONTROL_DASHBOARD_ORIGIN = 'https://auraalgo.example';
  process.env.PAPER_TRADING_API_URL = 'https://paper-api.example';
  process.env.BOT_CONTROL_TOKEN = 'test-control-token';
  let upstream;
  global.fetch = async (url, options) => {
    upstream = { url, options };
    return {
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"enabled":true}',
    };
  };
  const response = createResponse();
  try {
    await handler({
      method: 'POST',
      headers: { origin: 'https://auraalgo.example' },
      query: { path: ['bot', 'start'] },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"enabled":true}');
    assert.equal(upstream.url, 'https://paper-api.example/api/bot/start');
    assert.equal(upstream.options.method, 'POST');
    assert.equal(upstream.options.headers.Authorization, 'Bearer test-control-token');
    assert.equal(response.headers['Cache-Control'], 'no-store');
  } finally {
    global.fetch = originalFetch;
    if (originalEnvironment.dashboardOrigin === undefined) delete process.env.CONTROL_DASHBOARD_ORIGIN;
    else process.env.CONTROL_DASHBOARD_ORIGIN = originalEnvironment.dashboardOrigin;
    if (originalEnvironment.backendUrl === undefined) delete process.env.PAPER_TRADING_API_URL;
    else process.env.PAPER_TRADING_API_URL = originalEnvironment.backendUrl;
    if (originalEnvironment.token === undefined) delete process.env.BOT_CONTROL_TOKEN;
    else process.env.BOT_CONTROL_TOKEN = originalEnvironment.token;
  }
});

test('control gateway rejects other origins and non-allowlisted routes', async () => {
  const { default: handler } = await loadGateway();
  const previousOrigin = process.env.CONTROL_DASHBOARD_ORIGIN;
  process.env.CONTROL_DASHBOARD_ORIGIN = 'https://auraalgo.example';
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('Unexpected upstream request');
  };
  try {
    const originResponse = createResponse();
    await handler({
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
      query: { path: ['bot', 'start'] },
    }, originResponse);
    assert.equal(originResponse.statusCode, 403);

    const actionResponse = createResponse();
    await handler({
      method: 'POST',
      headers: { origin: 'https://auraalgo.example' },
      query: { path: ['market', 'status'] },
    }, actionResponse);
    assert.equal(actionResponse.statusCode, 503);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    if (previousOrigin === undefined) delete process.env.CONTROL_DASHBOARD_ORIGIN;
    else process.env.CONTROL_DASHBOARD_ORIGIN = previousOrigin;
  }
});

test('control gateway rejects non-POST requests and missing token configuration', async () => {
  const { default: handler } = await loadGateway();
  const previousOrigin = process.env.CONTROL_DASHBOARD_ORIGIN;
  const previousToken = process.env.BOT_CONTROL_TOKEN;
  process.env.CONTROL_DASHBOARD_ORIGIN = 'https://auraalgo.example';
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('Unexpected upstream request');
  };
  try {
    const methodResponse = createResponse();
    await handler({
      method: 'GET',
      headers: { origin: 'https://auraalgo.example' },
      query: { path: ['bot', 'start'] },
    }, methodResponse);
    assert.equal(methodResponse.statusCode, 405);
    assert.equal(methodResponse.headers.Allow, 'POST');

    delete process.env.BOT_CONTROL_TOKEN;
    const configResponse = createResponse();
    await handler({
      method: 'POST',
      headers: { origin: 'https://auraalgo.example' },
      query: { path: ['bot', 'start'] },
    }, configResponse);
    assert.equal(configResponse.statusCode, 503);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    if (previousOrigin === undefined) delete process.env.CONTROL_DASHBOARD_ORIGIN;
    else process.env.CONTROL_DASHBOARD_ORIGIN = previousOrigin;
    if (previousToken === undefined) delete process.env.BOT_CONTROL_TOKEN;
    else process.env.BOT_CONTROL_TOKEN = previousToken;
  }
});

test('control gateway reports upstream failures without exposing configuration', async () => {
  const { default: handler } = await loadGateway();
  const originalEnvironment = {
    dashboardOrigin: process.env.CONTROL_DASHBOARD_ORIGIN,
    backendUrl: process.env.PAPER_TRADING_API_URL,
    token: process.env.BOT_CONTROL_TOKEN,
  };
  const originalFetch = global.fetch;
  process.env.CONTROL_DASHBOARD_ORIGIN = 'https://auraalgo.example';
  process.env.PAPER_TRADING_API_URL = 'https://paper-api.example';
  process.env.BOT_CONTROL_TOKEN = 'test-control-token';
  global.fetch = async () => {
    throw new Error('Upstream detail must not be returned');
  };
  try {
    const response = createResponse();
    await handler({
      method: 'POST',
      headers: { origin: 'https://auraalgo.example' },
      query: { path: ['bot', 'stop'] },
    }, response);
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, { error: 'Paper trading backend is unavailable' });
  } finally {
    global.fetch = originalFetch;
    if (originalEnvironment.dashboardOrigin === undefined) delete process.env.CONTROL_DASHBOARD_ORIGIN;
    else process.env.CONTROL_DASHBOARD_ORIGIN = originalEnvironment.dashboardOrigin;
    if (originalEnvironment.backendUrl === undefined) delete process.env.PAPER_TRADING_API_URL;
    else process.env.PAPER_TRADING_API_URL = originalEnvironment.backendUrl;
    if (originalEnvironment.token === undefined) delete process.env.BOT_CONTROL_TOKEN;
    else process.env.BOT_CONTROL_TOKEN = originalEnvironment.token;
  }
});
