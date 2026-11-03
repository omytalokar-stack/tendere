function createAgentReadRateLimit({ limit = 60, windowMs = 60_000 } = {}) {
  let windowStartedAt = Date.now();
  let requestCount = 0;

  return function agentReadRateLimit(req, res, next) {
    const now = Date.now();
    if (now - windowStartedAt >= windowMs) {
      windowStartedAt = now;
      requestCount = 0;
    }

    requestCount += 1;
    if (requestCount > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - windowStartedAt)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many assistant API requests' });
    }
    return next();
  };
}

module.exports = createAgentReadRateLimit;
