const DEFAULT_NTFY_TOPIC = 'auraalgo_live_897k3_rajesh';
const REQUEST_TIMEOUT_MS = 5_000;

function formatPrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'Market Quote';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 8 })} USDT`;
}

function formatPnl(value) {
  if (!Number.isFinite(value)) return 'unavailable';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDT`;
}

function logFailure(logger, error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('ntfy notification delivery failed', { error: message });
}

async function sendAlert(createMessage, logger = console) {
  if (process.env.NODE_ENV === 'test') return;

  try {
    const { title, body } = createMessage();
    const topic = process.env.NTFY_TOPIC || DEFAULT_NTFY_TOPIC;
    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ntfy returned HTTP ${response.status}`);
    }
  } catch (error) {
    logFailure(logger, error);
  }
}

function notifyTradeOpened(trade, logger) {
  return sendAlert(() => ({
    title: 'AuraAlgo: New Trade',
    body: [
      `Symbol: ${trade.symbol}`,
      `Direction: ${trade.side}`,
      `Entry Price: ${formatPrice(trade.entryPrice)}`,
      `Stop Loss: ${formatPrice(trade.stopLoss)}`,
      `Target: ${formatPrice(trade.takeProfit)}`,
    ].join('\n'),
  }), logger);
}

function notifyTradeClosed(trade, logger) {
  return sendAlert(() => ({
    title: 'AuraAlgo: Trade Closed',
    body: [
      `Symbol: ${trade.symbol}`,
      `Exit Price: ${formatPrice(trade.exitPrice)}`,
      `Realized PnL: ${formatPnl(trade.pnlUsd)}`,
      `Exit Reason: ${trade.closeReason}`,
    ].join('\n'),
  }), logger);
}

function notifyDailyLossLimit(limit, logger) {
  return sendAlert(() => ({
    title: 'AuraAlgo: Daily Loss Limit Reached',
    body: `Realized daily loss reached the configured limit of ${formatPrice(limit)}. New paper entries are paused for today.`,
  }), logger);
}

module.exports = {
  notifyTradeOpened,
  notifyTradeClosed,
  notifyDailyLossLimit,
};
