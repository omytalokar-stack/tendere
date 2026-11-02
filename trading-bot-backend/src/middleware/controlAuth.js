const crypto = require('node:crypto');
const { config } = require('../config');

function controlAuth(req, res, next) {
  if (!config.controlToken) {
    return res.status(503).json({ error: 'Bot control is disabled until BOT_CONTROL_TOKEN is configured' });
  }
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(config.controlToken);
  const valid = suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (!valid) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

module.exports = controlAuth;
