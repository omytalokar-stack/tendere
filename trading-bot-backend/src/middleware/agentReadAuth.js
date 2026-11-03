const crypto = require('node:crypto');
const { config } = require('../config');

function agentReadAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (!config.agentReadToken) {
    return res.status(503).json({ error: 'AI read API is not configured', code: 'AI_READ_API_NOT_CONFIGURED' });
  }
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const suppliedBuffer = Buffer.from(match ? match[1] : '');
  const expectedBuffer = Buffer.from(config.agentReadToken);
  const valid = suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (!valid) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

module.exports = agentReadAuth;
