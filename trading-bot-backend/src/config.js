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
const entryIntervals = [...new Set(['5m', '15m', candleInterval])];

const binanceRestUrl = (process.env.BINANCE_REST_URL || 'https://data-api.binance.vision')
  .replace(/\/+$/, '');
const binanceRestHostname = new URL(binanceRestUrl).hostname.toLowerCase();
if (binanceRestHostname === 'api.binance.com' || /^api[1-3]\.binance\.com$/.test(binanceRestHostname)) {
  throw new Error('BINANCE_REST_URL must use https://data-api.binance.vision, not the Binance trading API host');
}
const restBootstrapSetting = (process.env.BINANCE_REST_BOOTSTRAP_ENABLED || 'true').toLowerCase();
if (restBootstrapSetting !== 'true' && restBootstrapSetting !== 'false') {
  throw new Error('BINANCE_REST_BOOTSTRAP_ENABLED must be true or false');
}
const dailyConsecutiveLossLimit = numberFromEnv('DAILY_CONSECUTIVE_LOSS_LIMIT', 2, {
  min: 1,
  max: 100,
});
if (!Number.isInteger(dailyConsecutiveLossLimit)) {
  throw new Error('DAILY_CONSECUTIVE_LOSS_LIMIT must be an integer');
}

const config = {
  port: numberFromEnv('PORT', 3001, { min: 1, max: 65535 }),
  mongoUri: process.env.MONGODB_URI,
  controlToken: process.env.BOT_CONTROL_TOKEN,
  agentReadToken: process.env.AI_READ_API_TOKEN,
  geminiApiKey: process.env.GEMINI_API_KEY,
  agentPollingIntervalSeconds: numberFromEnv('AI_READ_POLL_INTERVAL_SECONDS', 15, { min: 5, max: 3600 }),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  candleInterval,
  entryIntervals,
  botEnabled: (process.env.BOT_ENABLED || 'true').toLowerCase() === 'true',
  initialBalance: numberFromEnv('INITIAL_BALANCE_USDT', 10_000, { min: 1 }),
  leverage: numberFromEnv('PAPER_LEVERAGE', 1, { min: 1, max: 5 }),
  rewardRiskRatio: numberFromEnv('REWARD_RISK_RATIO', 2, { min: 1, max: 10 }),
  dailyLossLimit: numberFromEnv('DAILY_LOSS_LIMIT_USDT', 400, { min: 1 }),
  dailyConsecutiveLossLimit,
  ntfyTopic: process.env.NTFY_TOPIC || 'auraalgo_live_897k3_rajesh',
  binanceRestUrl,
  binanceRestBootstrapEnabled: restBootstrapSetting === 'true',
  binanceWsUrl: process.env.BINANCE_WS_URL || 'wss://data-stream.binance.vision/stream',
};

module.exports = { config, SYMBOLS };
