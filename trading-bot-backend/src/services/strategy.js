const {
  ADX,
  ATR,
  BollingerBands,
  EMA,
  MACD,
  OBV,
  RSI,
  SMA,
  StochasticRSI,
} = require('technicalindicators');

const REQUIRED_CANDLES = 250;
const MAX_HTF_SOURCE_CANDLES = 830;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const SUPER_TREND_PERIOD = 10;
const SUPER_TREND_MULTIPLIER = 3;
const MIN_ENTRY_VOTES = 7;
const MIN_ENTRY_VOLUME_RATIO = 1.2;
const MIN_ENTRY_ADX = 22;
const MAX_LONG_RSI = 68;
const MIN_SHORT_RSI = 32;
const TOP_OPPORTUNITIES = 2;
const STANDARD_ALLOCATION_PERCENT = 25;
const STANDARD_MAX_ALLOCATION = 2_500;
const A_PLUS_ALLOCATION_PERCENT = 35;
const A_PLUS_MAX_ALLOCATION = 3_500;

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
      trend = candle.close >= midpoint ? 'BULLISH' : 'BEARISH';
    } else {
      finalUpper = basicUpper < finalUpper || previousClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || previousClose < finalLower ? basicLower : finalLower;
      trend = trend === 'BEARISH'
        ? (candle.close > finalUpper ? 'BULLISH' : 'BEARISH')
        : (candle.close < finalLower ? 'BEARISH' : 'BULLISH');
    }
    value = trend === 'BULLISH' ? finalLower : finalUpper;
  }

  if (!Number.isFinite(value)) return null;
  return { value, direction: trend };
}

function validateCandles(candles) {
  if (!Array.isArray(candles)
    || candles.length < REQUIRED_CANDLES
    || candles.length > MAX_HTF_SOURCE_CANDLES) throw insufficientData();
  if (!candles.every((candle) => candle.isClosed === true
    && [candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
      .every(Number.isFinite)
    && candle.open > 0
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.low > 0
    && candle.close > 0
    && candle.volume >= 0)) throw insufficientData();
  if (!candles.slice(1).every((candle, index) =>
    candle.openTime > candles[index].openTime)) throw insufficientData();
}

function resampleClosedCandles(candles, groupSize) {
  if (!Number.isInteger(groupSize) || groupSize < 1) {
    throw new Error('Higher-timeframe group size must be a positive integer');
  }
  const bucketDuration = FIFTEEN_MINUTES_MS * groupSize;
  const groups = [];
  let bucketStart = null;
  let group = [];
  const appendGroup = () => {
    if (group.length !== groupSize) return;
    groups.push({
      symbol: group[0].symbol || null,
      openTime: group[0].openTime,
      closeTime: group[group.length - 1].closeTime,
      open: group[0].open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
      isClosed: true,
    });
  };

  for (const candle of candles) {
    const currentBucket = Math.floor(candle.openTime / bucketDuration) * bucketDuration;
    if (currentBucket !== bucketStart) {
      appendGroup();
      bucketStart = currentBucket;
      group = candle.openTime === currentBucket ? [candle] : [];
      continue;
    }

    const expectedOpenTime = currentBucket + group.length * FIFTEEN_MINUTES_MS;
    if (group.length > 0 && candle.openTime === expectedOpenTime) group.push(candle);
    else group = [];
  }
  appendGroup();
  return groups;
}

function calculateHigherTimeframeTrend(candles) {
  const close = candles.map((candle) => candle.close);
  const latestClose = close.at(-1) ?? null;
  const ema20 = close.length >= 20
    ? latest(EMA.calculate({ values: close, period: 20 }))
    : null;
  const ema50 = close.length >= 50
    ? latest(EMA.calculate({ values: close, period: 50 }))
    : null;
  const ema200 = close.length >= 200
    ? latest(EMA.calculate({ values: close, period: 200 }))
    : null;
  const trend = ema50 !== null && ema20 !== null && latestClose !== null
    ? latestClose > ema50 && ema20 > ema50
      ? 'BULLISH'
      : latestClose < ema50 && ema20 < ema50
        ? 'BEARISH'
        : 'NEUTRAL'
    : 'NEUTRAL';
  return {
    trend,
    close: latestClose,
    ema20: ema20 ?? null,
    ema50: ema50 ?? null,
    ema200: ema200 ?? null,
    candleCount: candles.length,
  };
}

function calculateHigherTimeframeTrends(candles) {
  const oneHourCandles = resampleClosedCandles(candles, 4);
  const fourHourCandles = resampleClosedCandles(candles, 16);
  return {
    htf1h: calculateHigherTimeframeTrend(oneHourCandles),
    htf4h: calculateHigherTimeframeTrend(fourHourCandles),
  };
}

function getHtfEntryContext(direction, htf1hTrend, htf4hTrend) {
  const alignedTrend = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
  const opposite = direction === 'LONG' ? 'BEARISH' : 'BULLISH';
  const counterTrendBlocked = Boolean(direction
    && htf1hTrend === opposite
    && htf4hTrend === opposite);
  const aligned = Boolean(direction
    && htf1hTrend === alignedTrend
    && htf4hTrend === alignedTrend);
  return {
    htfAlignment: aligned ? 'ALIGNED_1H_4H' : 'STANDARD',
    allocationPercent: aligned ? A_PLUS_ALLOCATION_PERCENT : STANDARD_ALLOCATION_PERCENT,
    counterTrendBlocked,
  };
}

function indicatorDirection(analysis) {
  const bullishCount = analysis.bullishCount ?? analysis.buyVotes;
  const bearishCount = analysis.bearishCount ?? analysis.sellVotes;
  if (bullishCount >= MIN_ENTRY_VOTES
    && analysis.close > analysis.ema200
    && analysis.ema20 > analysis.ema50
    && analysis.adx >= 20
    && analysis.pdi > analysis.mdi
    && analysis.adx > MIN_ENTRY_ADX
    && analysis.volumeRatio >= MIN_ENTRY_VOLUME_RATIO
    && analysis.rsi <= MAX_LONG_RSI) return 'LONG';
  if (bearishCount >= MIN_ENTRY_VOTES
    && analysis.close < analysis.ema200
    && analysis.ema20 < analysis.ema50
    && analysis.adx >= 20
    && analysis.mdi > analysis.pdi
    && analysis.adx > MIN_ENTRY_ADX
    && analysis.volumeRatio >= MIN_ENTRY_VOLUME_RATIO
    && analysis.rsi >= MIN_SHORT_RSI) return 'SHORT';
  return null;
}

function analyzeCandles(candles, higherTimeframes = null) {
  validateCandles(candles);

  const strategyCandles = candles.slice(-REQUIRED_CANDLES);
  const close = strategyCandles.map((candle) => candle.close);
  const high = strategyCandles.map((candle) => candle.high);
  const low = strategyCandles.map((candle) => candle.low);
  const volume = strategyCandles.map((candle) => candle.volume);
  const latestCandle = strategyCandles[strategyCandles.length - 1];
  const higherTimeframeAnalysis = higherTimeframes || calculateHigherTimeframeTrends(candles);
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
  const stochasticRsi = latest(StochasticRSI.calculate({
    values: close,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  }));
  const obvSeries = OBV.calculate({ close, volume });
  const obv = latest(obvSeries);
  const obvSma20 = latest(SMA.calculate({ values: obvSeries, period: 20 }));
  const supertrend = calculateSupertrend(strategyCandles);
  const priorVolumes = volume.slice(-21, -1);
  if (priorVolumes.length !== 20) throw insufficientData();
  const averageVolume = priorVolumes.reduce((sum, item) => sum + item, 0) / priorVolumes.length;
  const currentVolume = latestCandle.volume;
  const volumeRatio = averageVolume > 0 ? currentVolume / averageVolume : null;
  const percentB = bands && bands.upper !== bands.lower
    ? (latestCandle.close - bands.lower) / (bands.upper - bands.lower)
    : null;

  const requiredValues = [
    rsi, ema20, ema50, ema200, macd?.MACD, macd?.signal, macd?.histogram,
    bands?.middle, bands?.upper, bands?.lower, percentB, atr, adx?.adx, adx?.pdi,
    adx?.mdi, stochasticRsi?.k, stochasticRsi?.d, obv, obvSma20, supertrend?.value,
    averageVolume, volumeRatio,
  ];
  if (!requiredValues.every(Number.isFinite) || averageVolume <= 0) {
    throw new Error('INVALID_LIVE_MARKET_DATA: closed-candle indicators could not be calculated');
  }

  const stochasticDirection = stochasticRsi.k < 20 && stochasticRsi.k > stochasticRsi.d
    ? 'BULLISH'
    : stochasticRsi.k > 80 && stochasticRsi.k < stochasticRsi.d
      ? 'BEARISH'
      : stochasticRsi.k > stochasticRsi.d
        ? 'BULLISH'
        : stochasticRsi.k < stochasticRsi.d ? 'BEARISH' : 'NEUTRAL';
  const volumeSpikeDirection = volumeRatio >= 1.15
    ? latestCandle.close > strategyCandles[strategyCandles.length - 2].close
      ? 'BULLISH'
      : latestCandle.close < strategyCandles[strategyCandles.length - 2].close ? 'BEARISH' : 'NEUTRAL'
    : 'NEUTRAL';
  const adxDirection = adx.adx >= 20
    ? adx.pdi > adx.mdi ? 'BULLISH' : adx.mdi > adx.pdi ? 'BEARISH' : 'NEUTRAL'
    : 'NEUTRAL';
  const indicators = [
    { name: 'EMA-200 macro trend', value: ema200, direction: latestCandle.close > ema200 ? 'BULLISH' : latestCandle.close < ema200 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'EMA-20/50 ribbon', value: { ema20, ema50 }, direction: ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'Supertrend-10/3', value: supertrend, direction: supertrend.direction, weight: 1 },
    { name: 'RSI-14', value: rsi, direction: rsi <= 35 ? 'BULLISH' : rsi >= 65 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'MACD-12/26/9', value: macd, direction: macd.histogram > 0 ? 'BULLISH' : macd.histogram < 0 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'Stoch RSI-14/14/3/3', value: stochasticRsi, direction: stochasticDirection, weight: 1 },
    { name: 'Bollinger-20/2', value: { ...bands, percentB }, direction: percentB > 0.5 && latestCandle.close > bands.middle ? 'BULLISH' : percentB < 0.5 && latestCandle.close < bands.middle ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'ADX/+DI/-DI-14', value: adx, direction: adxDirection, weight: 1 },
    { name: 'OBV vs SMA-20', value: { obv, obvSma20 }, direction: obv > obvSma20 ? 'BULLISH' : obv < obvSma20 ? 'BEARISH' : 'NEUTRAL', weight: 1 },
    { name: 'ATR-14 + candle body', value: { atr, body: latestCandle.close - latestCandle.open }, direction: latestCandle.close > latestCandle.open ? 'BULLISH' : latestCandle.close < latestCandle.open ? 'BEARISH' : 'NEUTRAL', weight: 1 },
  ].map((indicator) => ({
    ...indicator,
    vote: indicator.direction === 'BULLISH'
      ? 'BUY'
      : indicator.direction === 'BEARISH' ? 'SELL' : 'NEUTRAL',
  }));
  const bullishCount = indicators.filter((item) => item.direction === 'BULLISH').length;
  const bearishCount = indicators.filter((item) => item.direction === 'BEARISH').length;
  const analysis = {
    symbol: latestCandle.symbol || null,
    side: null,
    bullishCount,
    bearishCount,
    buyVotes: bullishCount,
    sellVotes: bearishCount,
    totalVotes: indicators.length,
    close: latestCandle.close,
    currentPrice: latestCandle.close,
    ema20,
    ema50,
    ema200,
    atr,
    rsi,
    adx: adx.adx,
    pdi: adx.pdi,
    mdi: adx.mdi,
    vwap: calculateVwap(strategyCandles),
    supertrend,
    stochasticRsi,
    macd,
    bollinger: { ...bands, percentB },
    obv,
    obvSma20,
    currentVolume,
    averageVolume,
    volumeRatio,
    volumeSpikeRatio: volumeRatio,
    opportunityScore: volumeRatio * adx.adx,
    htf1h: higherTimeframeAnalysis.htf1h,
    htf4h: higherTimeframeAnalysis.htf4h,
    htf1hTrend: higherTimeframeAnalysis.htf1h.trend,
    htf4hTrend: higherTimeframeAnalysis.htf4h.trend,
    indicators,
    strategy: 'QuantConsensus 10-source closed-candle engine',
  };
  const direction = indicatorDirection(analysis);
  const htfContext = getHtfEntryContext(direction, analysis.htf1hTrend, analysis.htf4hTrend);
  analysis.side = htfContext.counterTrendBlocked ? null : direction;
  analysis.htfAlignment = htfContext.htfAlignment;
  analysis.allocationPercent = htfContext.allocationPercent;
  analysis.counterTrendBlocked = htfContext.counterTrendBlocked;
  return analysis;
}

function rankOpportunities(opportunities, limit = TOP_OPPORTUNITIES) {
  return [...opportunities]
    .map((item) => ({
      ...item,
      opportunityScore: Number(item.opportunityScore ?? item.analysis?.opportunityScore),
    }))
    .filter((item) => Number.isFinite(item.opportunityScore))
    .sort((left, right) => right.opportunityScore - left.opportunityScore
      || left.symbol.localeCompare(right.symbol))
    .slice(0, limit)
    .map((item, index) => ({ ...item, opportunityRank: index + 1, isTopOpportunity: true }));
}

function getEntrySignal(analysis) {
  const direction = indicatorDirection(analysis);
  if (!direction) return null;
  const { counterTrendBlocked } = getHtfEntryContext(
    direction,
    analysis.htf1hTrend,
    analysis.htf4hTrend,
  );
  return counterTrendBlocked ? null : direction;
}

function getConfirmedEntrySignal(analysis, confirmationAnalysis) {
  const direction = getEntrySignal(analysis);
  return direction && getEntrySignal(confirmationAnalysis) === direction ? direction : null;
}

function sizePosition({
  availableMargin,
  entryPrice,
  allocationPercent = STANDARD_ALLOCATION_PERCENT,
  maxAllocation = allocationPercent === A_PLUS_ALLOCATION_PERCENT
    ? A_PLUS_MAX_ALLOCATION
    : STANDARD_MAX_ALLOCATION,
}) {
  if (![availableMargin, entryPrice, allocationPercent, maxAllocation].every(Number.isFinite)
    || availableMargin <= 0 || entryPrice <= 0
    || allocationPercent <= 0 || allocationPercent > 100
    || maxAllocation <= 0) {
    throw new Error('Invalid inputs for paper position sizing');
  }
  const allocatedMargin = Math.min(availableMargin * allocationPercent / 100, maxAllocation);
  const quantity = Number((allocatedMargin / entryPrice).toFixed(8));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Paper position size must be positive');
  }
  return {
    margin: Number(allocatedMargin.toFixed(8)),
    quantity,
    allocatedMargin: Number(allocatedMargin.toFixed(8)),
    allocationPercent,
  };
}

module.exports = {
  analyzeCandles,
  getEntrySignal,
  getConfirmedEntrySignal,
  rankOpportunities,
  sizePosition,
  REQUIRED_CANDLES,
  MAX_HTF_SOURCE_CANDLES,
  MIN_CANDLES: REQUIRED_CANDLES,
  MIN_ENTRY_VOTES,
  MIN_ENTRY_VOLUME_RATIO,
  MIN_ENTRY_ADX,
  MAX_LONG_RSI,
  MIN_SHORT_RSI,
  TOP_OPPORTUNITIES,
  calculateVwap,
  calculateSupertrend,
  resampleClosedCandles,
  calculateHigherTimeframeTrends,
  getHtfEntryContext,
};
