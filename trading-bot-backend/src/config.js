require('dotenv').config();

const SYMBOLS = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT'];
const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']);

function numberFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

const candleInterval = process.env.CANDLE_INTERVAL || '15m';
if (!INTERVALS.has(candleInterval)) {
  throw new Error(`Unsupported CANDLE_INTERVAL: ${candleInterval}`);
}

const config = {
  port: numberFromEnv('PORT', 3001, { min: 1, max: 65535 }),
  mongoUri: process.env.MONGODB_URI,
  controlToken: process.env.BOT_CONTROL_TOKEN,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  candleInterval,
  botEnabled: (process.env.BOT_ENABLED || 'true').toLowerCase() === 'true',
  initialBalance: numberFromEnv('INITIAL_BALANCE_USDT', 10_000, { min: 1 }),
  leverage: numberFromEnv('PAPER_LEVERAGE', 1, { min: 1, max: 5 }),
  rewardRiskRatio: numberFromEnv('REWARD_RISK_RATIO', 2, { min: 1, max: 10 }),
  dailyLossLimit: numberFromEnv('DAILY_LOSS_LIMIT_USDT', 400, { min: 1 }),
  binanceRestUrl: process.env.BINANCE_REST_URL || 'https://data-api.binance.vision',
  binanceWsUrl: process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/stream',
};

module.exports = { config, SYMBOLS };
