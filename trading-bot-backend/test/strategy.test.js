const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeCandles,
  getEntrySignal,
  getConfirmedEntrySignal,
  sizePosition,
  MIN_CANDLES,
  MIN_ENTRY_VOTES,
  RISK_PERCENT,
} = require('../src/services/strategy');

test('analysis refuses to calculate from fewer than 250 finalized candles', () => {
  assert.throws(() => analyzeCandles([]), { code: 'INSUFFICIENT_HISTORICAL_DATA' });
  assert.throws(
    () => analyzeCandles(new Array(MIN_CANDLES - 1)),
    { code: 'INSUFFICIENT_HISTORICAL_DATA' },
  );
});

test('position sizing risks 0.75 percent of wallet balance at the stop', () => {
  const size = sizePosition({
    balance: 10_000,
    entryPrice: 100,
    stopLoss: 95,
    leverage: 1,
  });
  assert.equal(RISK_PERCENT, 0.75);
  assert.equal(size.riskBudgetUsd, 75);
  assert.equal(size.quantity, 15);
  assert.equal(size.margin, 1_500);
  assert.equal(size.maxRiskUsd, 75);
});

test('leverage changes required margin without changing the 0.75-percent risk amount', () => {
  const size = sizePosition({
    balance: 10_000,
    entryPrice: 100,
    stopLoss: 99,
    leverage: 5,
  });
  assert.equal(size.quantity, 75);
  assert.equal(size.margin, 1_500);
  assert.equal(size.maxRiskUsd, 75);
});

test('position sizing rejects zero-distance stop losses', () => {
  assert.throws(() => sizePosition({
    balance: 10_000,
    entryPrice: 100,
    stopLoss: 100,
    leverage: 1,
  }), /Stop-loss distance/);
});

test('position sizing rejects non-positive stop prices', () => {
  assert.throws(() => sizePosition({
    balance: 10_000,
    entryPrice: 100,
    stopLoss: 0,
    leverage: 1,
  }), /Invalid inputs/);
});

test('entry requires ADX 22, strict EMA trend alignment, seven votes, volume, and book pressure', () => {
  const analysis = {
    buyVotes: 7,
    sellVotes: 2,
    volumeRatio: 1.2,
    currentPrice: 103,
    ema20: 102,
    ema50: 101,
    ema200: 100,
    adx: 22,
    orderBookPressure: { bidPercent: 54, askPercent: 46 },
  };
  assert.equal(MIN_ENTRY_VOTES, 7);
  assert.equal(getEntrySignal(analysis), 'LONG');
  assert.equal(getEntrySignal({
    ...analysis,
    adx: 21.99,
  }), null);
  assert.equal(getEntrySignal({
    ...analysis,
    currentPrice: 102,
  }), null);
  assert.equal(getEntrySignal({
    ...analysis,
    ema20: 101,
    ema50: 102,
  }), null);
  assert.equal(getEntrySignal({
    ...analysis,
    orderBookPressure: { bidPercent: 53.99, askPercent: 46.01 },
  }), null);
  assert.equal(getEntrySignal({
    ...analysis,
    volumeRatio: 1.199999,
    orderBookPressure: { bidPercent: 55, askPercent: 45 },
  }), null);
  assert.equal(getEntrySignal({ ...analysis, buyVotes: 6 }), null);
  assert.equal(getEntrySignal({ ...analysis, currentPrice: 100 }), null);
  assert.equal(getEntrySignal({ ...analysis, currentPrice: 99 }), null);
  assert.equal(getEntrySignal({
    buyVotes: 2,
    sellVotes: 7,
    volumeRatio: 1.2,
    currentPrice: 97,
    ema20: 98,
    ema50: 99,
    ema200: 100,
    adx: 22,
    orderBookPressure: { bidPercent: 46, askPercent: 54 },
  }), 'SHORT');
  assert.equal(getEntrySignal({
    buyVotes: 2,
    sellVotes: 7,
    volumeRatio: 1.2,
    currentPrice: 99,
    ema20: 98,
    ema50: 99,
    ema200: 100,
    adx: 22,
    orderBookPressure: { bidPercent: 46, askPercent: 54 },
  }), null);
});

test('five-minute entries require the fifteen-minute signal to confirm the same direction', () => {
  const long = {
    buyVotes: 7,
    sellVotes: 2,
    volumeRatio: 1.2,
    currentPrice: 103,
    ema20: 102,
    ema50: 101,
    ema200: 100,
    adx: 22,
    orderBookPressure: { bidPercent: 54, askPercent: 46 },
  };
  const short = {
    buyVotes: 2,
    sellVotes: 7,
    volumeRatio: 1.2,
    currentPrice: 97,
    ema20: 98,
    ema50: 99,
    ema200: 100,
    adx: 22,
    orderBookPressure: { bidPercent: 46, askPercent: 54 },
  };
  assert.equal(getConfirmedEntrySignal(long, long), 'LONG');
  assert.equal(getConfirmedEntrySignal(long, short), null);
  assert.equal(getConfirmedEntrySignal(long, { ...long, volumeRatio: 1.19 }), null);
  assert.equal(getConfirmedEntrySignal({ ...short, volumeRatio: 1.19 }, short), null);
});
