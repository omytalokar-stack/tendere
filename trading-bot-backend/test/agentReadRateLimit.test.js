const test = require('node:test');
const assert = require('node:assert/strict');
const createAgentReadRateLimit = require('../src/middleware/agentReadRateLimit');

test('agent read rate limit returns 429 and Retry-After after the configured request budget', () => {
  const rateLimit = createAgentReadRateLimit({ limit: 2, windowMs: 60_000 });
  let nextCalls = 0;
  const response = {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const request = {};
  const next = () => { nextCalls += 1; };

  rateLimit(request, response, next);
  rateLimit(request, response, next);
  rateLimit(request, response, next);

  assert.equal(nextCalls, 2);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['Retry-After'], '60');
  assert.deepEqual(response.body, { error: 'Too many assistant API requests' });
});
