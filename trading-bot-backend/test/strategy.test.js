const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeCandles,
  getEntrySignal,
  getConfirmedEntrySignal,
  rankOpportunities,
  sizePosition,
  REQUIRED_CANDLES,
  MIN_ENTRY_VOTES,
  TOP_OPPORTUNITIES,
} = require('../src/services/strategy');

function trendingCandles(direction = 1) {
  let close = 100;
  const upPattern = [1, -0.4, 0.8, -0.7, 1, -0.6, 0.6];
  const finalPattern = [-1, -1, -1, 1, 1, 1, 1];
  return Array.from({ length: REQUIRED_CANDLES }, (_, index) => {
    const change = direction * (index < 480
      ? upPattern[index % upPattern.length]
      : finalPattern[(index - 480) % finalPattern.length]);
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
      volume: index === REQUIRED_CANDLES - 1 ? 150 : 100,
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

test('analysis requires exactly 500 valid closed candles and returns 10 equally weighted indicators', () => {
  assert.throws(() => analyzeCandles([]), { code: 'INSUFFICIENT_HISTORICAL_DATA' });
  assert.throws(
    () => analyzeCandles(trendingCandles().slice(1)),
    { code: 'INSUFFICIENT_HISTORICAL_DATA' },
  );
  const unclosed = trendingCandles();
  unclosed[499].isClosed = false;
  assert.throws(() => analyzeCandles(unclosed), { code: 'INSUFFICIENT_HISTORICAL_DATA' });

  const analysis = analyzeCandles(trendingCandles());
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
  assert.equal(analysis.volumeSpikeRatio, 1.5);
  assert.equal(analysis.opportunityScore, analysis.volumeSpikeRatio * analysis.adx);
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
  });
  assert.deepEqual(sizePosition({ availableMargin: 4_000, entryPrice: 100 }), {
    margin: 1_000,
    quantity: 10,
    allocatedMargin: 1_000,
  });
  assert.deepEqual(sizePosition({ availableMargin: 20_000, entryPrice: 10 }), {
    margin: 2_500,
    quantity: 250,
    allocatedMargin: 2_500,
  });
  assert.throws(() => sizePosition({ availableMargin: 0, entryPrice: 100 }), /Invalid inputs/);
});
