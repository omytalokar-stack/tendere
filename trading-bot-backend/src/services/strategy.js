const {
  ADX,
  ATR,
  BollingerBands,
  EMA,
  MACD,
  RSI,
} = require('technicalindicators');

const MIN_CANDLES = 250;
const SUPER_TREND_PERIOD = 10;
const SUPER_TREND_MULTIPLIER = 3;
const RISK_PERCENT = 0.75;
const MIN_ENTRY_VOTES = 7;
const MIN_ENTRY_VOLUME_RATIO = 1.2;
const MIN_ORDER_BOOK_PRESSURE_PERCENT = 54;

function latest(values) {
  return values.length ? values[values.length - 1] : undefined;
}

function insufficientData() {
  const error = new Error('INSUFFICIENT_HISTORICAL_DATA');
  error.code = 'INSUFFICIENT_HISTORICAL_DATA';
  return error;
}

function calculateVwap(candles) {
  const totals = candles.reduce((result, candle) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    result.priceVolume += typicalPrice * candle.volume;
    result.volume += candle.volume;
    return result;
  }, { priceVolume: 0, volume: 0 });
  if (totals.volume <= 0) return null;
  return totals.priceVolume / totals.volume;
}

function calculateSupertrend(candles) {
  const atrValues = ATR.calculate({
    high: candles.map((candle) => candle.high),
    low: candles.map((candle) => candle.low),
    close: candles.map((candle) => candle.close),
    period: SUPER_TREND_PERIOD,
  });
  const atrOffset = candles.length - atrValues.length;
  let finalUpper = null;
  let finalLower = null;
  let trend = null;
  let value = null;

  for (let index = 0; index < atrValues.length; index += 1) {
    const candleIndex = atrOffset + index;
    const candle = candles[candleIndex];
    const previousClose = candleIndex > 0 ? candles[candleIndex - 1].close : candle.close;
    const midpoint = (candle.high + candle.low) / 2;
    const basicUpper = midpoint + SUPER_TREND_MULTIPLIER * atrValues[index];
    const basicLower = midpoint - SUPER_TREND_MULTIPLIER * atrValues[index];

    if (finalUpper === null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = candle.close >= midpoint ? 'BUY' : 'SELL';
    } else {
      finalUpper = basicUpper < finalUpper || previousClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || previousClose < finalLower ? basicLower : finalLower;
      trend = trend === 'SELL'
        ? (candle.close > finalUpper ? 'BUY' : 'SELL')
        : (candle.close < finalLower ? 'SELL' : 'BUY');
    }
    value = trend === 'BUY' ? finalLower : finalUpper;
  }

  if (!Number.isFinite(value)) return null;
  return { value, direction: trend };
}

function getEntrySignal(analysis) {
  if (!analysis || !Number.isFinite(analysis.volumeRatio)
    || analysis.volumeRatio < MIN_ENTRY_VOLUME_RATIO
    || !Number.isFinite(analysis.adx)
    || analysis.adx < 22
    || !Number.isFinite(analysis.ema20)
    || !Number.isFinite(analysis.ema50)) return null;

  if (analysis.buyVotes >= MIN_ENTRY_VOTES
    && analysis.currentPrice > analysis.ema20
    && analysis.ema20 > analysis.ema50
    && analysis.currentPrice > analysis.ema200
    && analysis.orderBookPressure?.bidPercent >= MIN_ORDER_BOOK_PRESSURE_PERCENT) return 'LONG';
  if (analysis.sellVotes >= MIN_ENTRY_VOTES
    && analysis.currentPrice < analysis.ema20
    && analysis.ema20 < analysis.ema50
    && analysis.currentPrice < analysis.ema200
    && analysis.orderBookPressure?.askPercent >= MIN_ORDER_BOOK_PRESSURE_PERCENT) return 'SHORT';
  return null;
}

function getConfirmedEntrySignal(analysis, confirmationAnalysis) {
  const direction = getEntrySignal(analysis);
  return direction && getEntrySignal(confirmationAnalysis) === direction ? direction : null;
}

function analyzeCandles(candles, orderBook) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) throw insufficientData();
  if (!candles.every((candle) => candle.isFinal === true
    && [candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
      .every(Number.isFinite)
    && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 && candle.volume >= 0)) {
    throw insufficientData();
  }
  if (!orderBook || !Array.isArray(orderBook.bids) || !Array.isArray(orderBook.asks)
    || orderBook.bids.length < 20 || orderBook.asks.length < 20
    || !Number.isFinite(orderBook.bidQuantity) || !Number.isFinite(orderBook.askQuantity)) {
    const error = new Error('ORDERBOOK_DISCONNECTED');
    error.code = 'ORDERBOOK_DISCONNECTED';
    throw error;
  }

  const close = candles.map((candle) => candle.close);
  const high = candles.map((candle) => candle.high);
  const low = candles.map((candle) => candle.low);
  const volume = candles.map((candle) => candle.volume);
  const currentCandle = candles[candles.length - 1];
  const previousClose = close[close.length - 2];
  const currentClose = currentCandle.close;
  const rsi = latest(RSI.calculate({ values: close, period: 14 }));
  const ema20 = latest(EMA.calculate({ values: close, period: 20 }));
  const ema50 = latest(EMA.calculate({ values: close, period: 50 }));
  const ema200 = latest(EMA.calculate({ values: close, period: 200 }));
  const macd = latest(MACD.calculate({
    values: close,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  }));
  const bands = latest(BollingerBands.calculate({ values: close, period: 20, stdDev: 2 }));
  const atr = latest(ATR.calculate({ high, low, close, period: 14 }));
  const adx = latest(ADX.calculate({ high, low, close, period: 14 }));
  const vwap = calculateVwap(candles);
  const supertrend = calculateSupertrend(candles);
  const previous20Volumes = volume.slice(-21, -1);
  if (previous20Volumes.length !== 20) throw insufficientData();
  const averageVolume = previous20Volumes.reduce((sum, value) => sum + value, 0) / 20;
  const currentVolume = currentCandle.volume;
  const volumeRatio = averageVolume > 0 ? currentVolume / averageVolume : null;
  const bidAskTotal = orderBook.bidQuantity + orderBook.askQuantity;

  const calculatedValues = [
    rsi, ema20, ema50, ema200, macd?.histogram, bands?.middle, atr,
    adx?.adx, adx?.pdi, adx?.mdi, vwap, supertrend?.value, averageVolume, volumeRatio,
  ];
  if (!calculatedValues.every(Number.isFinite) || averageVolume <= 0 || bidAskTotal <= 0) {
    throw new Error('INVALID_LIVE_MARKET_DATA: Binance closed-candle indicators could not be calculated');
  }

  const votes = [
    { name: 'RSI-14', value: rsi, vote: rsi <= 35 ? 'BUY' : rsi >= 65 ? 'SELL' : 'NEUTRAL' },
    { name: 'MACD', value: macd.histogram, vote: macd.histogram > 0 ? 'BUY' : macd.histogram < 0 ? 'SELL' : 'NEUTRAL' },
    { name: 'EMA-20/50', value: { ema20, ema50 }, vote: ema20 > ema50 ? 'BUY' : ema20 < ema50 ? 'SELL' : 'NEUTRAL' },
    { name: 'EMA-200', value: ema200, vote: currentClose > ema200 ? 'BUY' : currentClose < ema200 ? 'SELL' : 'NEUTRAL' },
    { name: 'Supertrend-10/3', value: supertrend.value, vote: supertrend.direction },
    { name: 'Bollinger-20/2', value: bands, vote: currentClose > bands.middle ? 'BUY' : currentClose < bands.middle ? 'SELL' : 'NEUTRAL' },
    { name: 'ATR-14', value: atr, vote: 'NEUTRAL' },
    { name: 'ADX-14', value: adx.adx, vote: adx.adx >= 20 ? (adx.pdi > adx.mdi ? 'BUY' : adx.mdi > adx.pdi ? 'SELL' : 'NEUTRAL') : 'NEUTRAL' },
    { name: 'VWAP-500', value: vwap, vote: currentClose > vwap ? 'BUY' : currentClose < vwap ? 'SELL' : 'NEUTRAL' },
    { name: 'Volume-vs-20', value: { currentVolume, averageVolume, ratio: volumeRatio }, vote: volumeRatio >= 1.15 && currentClose > previousClose ? 'BUY' : volumeRatio >= 1.15 && currentClose < previousClose ? 'SELL' : 'NEUTRAL' },
  ];
  const buyVotes = votes.filter((vote) => vote.vote === 'BUY').length;
  const sellVotes = votes.filter((vote) => vote.vote === 'SELL').length;
  const analysis = {
    side: null,
    buyVotes,
    sellVotes,
    totalVotes: votes.length,
    currentPrice: currentClose,
    ema20,
    ema50,
    ema200,
    atr,
    rsi,
    adx: adx.adx,
    vwap,
    supertrend,
    currentVolume,
    averageVolume,
    volumeRatio,
    orderBookPressure: {
      bidQuantity: orderBook.bidQuantity,
      askQuantity: orderBook.askQuantity,
      bidPercent: (orderBook.bidQuantity / bidAskTotal) * 100,
      askPercent: (orderBook.askQuantity / bidAskTotal) * 100,
    },
    indicators: votes,
    strategy: '10-source Binance closed-candle consensus with L2 gate',
  };
  analysis.side = getEntrySignal(analysis);
  return analysis;
}

function sizePosition({ balance, entryPrice, stopLoss, leverage }) {
  if (![balance, entryPrice, stopLoss, leverage]
    .every(Number.isFinite)
    || balance <= 0
    || entryPrice <= 0
    || stopLoss <= 0
    || leverage < 1) {
    throw new Error('Invalid inputs for paper position sizing');
  }
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0) throw new Error('Stop-loss distance must be positive');

  const riskBudget = balance * (RISK_PERCENT / 100);
  const quantity = Number((riskBudget / stopDistance).toFixed(8));
  const margin = (quantity * entryPrice) / leverage;

  return {
    margin: Number(margin.toFixed(8)),
    quantity,
    maxRiskUsd: Number((quantity * stopDistance).toFixed(8)),
    riskBudgetUsd: Number(riskBudget.toFixed(8)),
  };
}

module.exports = {
  analyzeCandles,
  getEntrySignal,
  getConfirmedEntrySignal,
  sizePosition,
  MIN_CANDLES,
  RISK_PERCENT,
  MIN_ENTRY_VOTES,
  MIN_ENTRY_VOLUME_RATIO,
  MIN_ORDER_BOOK_PRESSURE_PERCENT,
  calculateVwap,
  calculateSupertrend,
};
