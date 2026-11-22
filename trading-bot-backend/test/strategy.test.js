const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeCandles,
  getEntrySignal,
  getConfirmedEntrySignal,
  rankOpportunities,
  sizePosition,
  calculateHigherTimeframeTrends,
  getHtfEntryContext,
  REQUIRED_CANDLES,
  MAX_HTF_SOURCE_CANDLES,
  MIN_ENTRY_VOTES,
  TOP_OPPORTUNITIES,
} = require('../src/services/strategy');

function trendingCandles(direction = 1, length = REQUIRED_CANDLES) {
  let close = 100;
  const upPattern = [1, -0.4, 0.8, -0.7, 1, -0.6, 0.6];
  const finalPattern = [-1, -1, -1, 1, 1, 1, 1];
  const finalPatternStart = length - 20;
  return Array.from({ length }, (_, index) => {
    const change = direction * (index < finalPatternStart
      ? upPattern[index % upPattern.length]
      : finalPattern[(index - finalPatternStart) % finalPattern.length]);
    const open = close;
    close += change;
    return {
      symbol: direction > 0 ? 'BTCUSDT' : 'ETHUSDT',
      time: new Date(index * 900_000),
      openTime: index * 900_000,
      closeTime: (index + 1) * 900_000 - 1,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: index === length - 1 ? 150 : 100,
      isFinal: true,
      isClosed: true,
    };
  });
}

function qualifyingLong(overrides = {}) {
  return {
    bullishCount: 7,
    bearishCount: 1,
    close: 103,
    ema20: 102,
    ema50: 101,
    ema200: 100,
    rsi: 60,
    adx: 22.01,
    pdi: 30,
    mdi: 20,
    volumeRatio: 1.2,
    ...overrides,
  };
}

function qualifyingShort(overrides = {}) {
  return {
    bullishCount: 1,
    bearishCount: 7,
    close: 97,
    ema20: 98,
    ema50: 99,
    ema200: 100,
    rsi: 40,
    adx: 22.01,
    pdi: 20,
    mdi: 30,
    volumeRatio: 1.2,
    ...overrides,
  };
}

test('analysis requires at least 250 valid closed candles and returns 10 equally weighted indicators', () => {
  assert.throws(() => analyzeCandles([]), { code: 'INSUFFICIENT_HISTORICAL_DATA' });
  assert.throws(
    () => analyzeCandles(trendingCandles(1, REQUIRED_CANDLES).slice(1)),
    { code: 'INSUFFICIENT_HISTORICAL_DATA' },
  );
  const unclosed = trendingCandles(1, REQUIRED_CANDLES);
  unclosed[REQUIRED_CANDLES - 1].isClosed = false;
  assert.throws(() => analyzeCandles(unclosed), { code: 'INSUFFICIENT_HISTORICAL_DATA' });

  const analysis = analyzeCandles(trendingCandles(1, REQUIRED_CANDLES));
  assert.equal(analysis.totalVotes, 10);
  assert.ok(analysis.indicators.every((indicator) => indicator.weight === 1));
  assert.deepEqual(analysis.indicators.map(({ name }) => name), [
    'EMA-200 macro trend',
    'EMA-20/50 ribbon',
    'Supertrend-10/3',
    'RSI-14',
    'MACD-12/26/9',
    'Stoch RSI-14/14/3/3',
    'Bollinger-20/2',
    'ADX/+DI/-DI-14',
    'OBV vs SMA-20',
    'ATR-14 + candle body',
  ]);
  assert.equal(analysis.side, 'LONG');
  assert.equal(analysis.htf4hTrend, 'NEUTRAL');
  assert.equal(analysis.htf4h.ema50, null);
  assert.equal(analysis.htfAlignment, 'STANDARD');
  assert.equal(analysis.allocationPercent, 25);
  assert.equal(analysis.volumeSpikeRatio, 1.5);
  assert.equal(analysis.opportunityScore, analysis.volumeSpikeRatio * analysis.adx);
});

test('higher-timeframe trends use only complete contiguous 15m groups and wait for EMA50 history', () => {
  const candles = trendingCandles(1, MAX_HTF_SOURCE_CANDLES);
  const trends = calculateHigherTimeframeTrends(candles);
  assert.equal(trends.htf1h.candleCount, 207);
  assert.equal(trends.htf4h.candleCount, 51);
  assert.equal(trends.htf1h.trend, 'BULLISH');
  assert.equal(trends.htf4h.trend, 'BULLISH');
  assert.ok(Number.isFinite(trends.htf1h.ema200));
  assert.equal(trends.htf4h.ema200, null);

  const incomplete = calculateHigherTimeframeTrends(trendingCandles());
  assert.equal(incomplete.htf4h.candleCount, 15);
  assert.equal(incomplete.htf4h.ema50, null);
  assert.equal(incomplete.htf4h.trend, 'NEUTRAL');
  const withGap = candles.filter((_, index) => index !== 10);
  assert.ok(calculateHigherTimeframeTrends(withGap).htf1h.candleCount < trends.htf1h.candleCount);
});

test('entry requires seven aligned votes, strict trend, ADX above 22, and a 1.2x volume spike', () => {
  assert.equal(MIN_ENTRY_VOTES, 7);
  assert.equal(getEntrySignal(qualifyingLong()), 'LONG');
  assert.equal(getEntrySignal(qualifyingShort()), 'SHORT');
  assert.equal(getEntrySignal(qualifyingLong({ bullishCount: 6 })), null);
  assert.equal(getEntrySignal(qualifyingLong({ adx: 22 })), null);
  assert.equal(getEntrySignal(qualifyingLong({ volumeRatio: 1.1999 })), null);
  assert.equal(getEntrySignal(qualifyingLong({ close: 100 })), null);
  assert.equal(getEntrySignal(qualifyingLong({ ema20: 100, ema50: 101 })), null);
  assert.equal(getEntrySignal(qualifyingLong({ pdi: 20, mdi: 30 })), null);
  assert.equal(getEntrySignal(qualifyingShort({ close: 100 })), null);
  assert.equal(getEntrySignal(qualifyingShort({ ema20: 99, ema50: 98 })), null);
  assert.equal(getEntrySignal(qualifyingShort({ pdi: 30, mdi: 20 })), null);
});

test('RSI extreme guard blocks long above 68 and short below 32', () => {
  assert.equal(getEntrySignal(qualifyingLong({ rsi: 68 })), 'LONG');
  assert.equal(getEntrySignal(qualifyingLong({ rsi: 68.01 })), null);
  assert.equal(getEntrySignal(qualifyingShort({ rsi: 32 })), 'SHORT');
  assert.equal(getEntrySignal(qualifyingShort({ rsi: 31.99 })), null);
});

test('higher-timeframe alignment boosts A+ sizing, preserves standard sizing, and blocks dual counter-trend entries', () => {
  assert.deepEqual(getHtfEntryContext('LONG', 'BULLISH', 'BULLISH'), {
    htfAlignment: 'ALIGNED_1H_4H',
    allocationPercent: 35,
    counterTrendBlocked: false,
  });
  assert.deepEqual(getHtfEntryContext('LONG', 'BULLISH', 'NEUTRAL'), {
    htfAlignment: 'STANDARD',
    allocationPercent: 25,
    counterTrendBlocked: false,
  });
  assert.deepEqual(getHtfEntryContext('LONG', 'BEARISH', 'BEARISH'), {
    htfAlignment: 'STANDARD',
    allocationPercent: 25,
    counterTrendBlocked: true,
  });
  assert.equal(getEntrySignal(qualifyingLong({
    htf1hTrend: 'BULLISH',
    htf4hTrend: 'BULLISH',
  })), 'LONG');
  assert.equal(getEntrySignal(qualifyingLong({
    htf1hTrend: 'BEARISH',
    htf4hTrend: 'BEARISH',
  })), null);
  assert.equal(getEntrySignal(qualifyingLong({
    htf1hTrend: 'BULLISH',
    htf4hTrend: 'NEUTRAL',
  })), 'LONG');
});

test('five-minute entries require the fifteen-minute signal to confirm the same side', () => {
  assert.equal(getConfirmedEntrySignal(qualifyingLong(), qualifyingLong()), 'LONG');
  assert.equal(getConfirmedEntrySignal(qualifyingLong(), qualifyingShort()), null);
  assert.equal(getConfirmedEntrySignal(qualifyingShort(), qualifyingShort()), 'SHORT');
  assert.equal(getConfirmedEntrySignal(qualifyingLong(), qualifyingLong({ adx: 22 })), null);
});

test('opportunity ranking returns only the top two and breaks score ties by symbol', () => {
  const ranked = rankOpportunities([
    { symbol: 'ETHUSDT', opportunityScore: 80 },
    { symbol: 'BTCUSDT', opportunityScore: 80 },
    { symbol: 'SOLUSDT', opportunityScore: 95 },
  ]);
  assert.equal(TOP_OPPORTUNITIES, 2);
  assert.deepEqual(ranked.map(({ symbol, opportunityRank, isTopOpportunity }) =>
    [symbol, opportunityRank, isTopOpportunity]), [
    ['SOLUSDT', 1, true],
    ['BTCUSDT', 2, true],
  ]);
});

test('position sizing is limited to 25% of free margin and capped at 2500 USDT', () => {
  assert.deepEqual(sizePosition({ availableMargin: 10_000, entryPrice: 100 }), {
    margin: 2_500,
    quantity: 25,
    allocatedMargin: 2_500,
    allocationPercent: 25,
  });
  assert.deepEqual(sizePosition({ availableMargin: 4_000, entryPrice: 100 }), {
    margin: 1_000,
    quantity: 10,
    allocatedMargin: 1_000,
    allocationPercent: 25,
  });
  assert.deepEqual(sizePosition({ availableMargin: 20_000, entryPrice: 10 }), {
    margin: 2_500,
    quantity: 250,
    allocatedMargin: 2_500,
    allocationPercent: 25,
  });
  assert.deepEqual(sizePosition({
    availableMargin: 10_000,
    entryPrice: 100,
    allocationPercent: 35,
  }), {
    margin: 3_500,
    quantity: 35,
    allocatedMargin: 3_500,
    allocationPercent: 35,
  });
  assert.deepEqual(sizePosition({
    availableMargin: 20_000,
    entryPrice: 100,
    allocationPercent: 35,
  }), {
    margin: 3_500,
    quantity: 35,
    allocatedMargin: 3_500,
    allocationPercent: 35,
  });
  assert.throws(() => sizePosition({ availableMargin: 0, entryPrice: 100 }), /Invalid inputs/);
});
