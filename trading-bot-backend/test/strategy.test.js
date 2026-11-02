const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeCandles,
  getEntrySignal,
  getConfirmedEntrySignal,
  sizePosition,
  MIN_CANDLES,
  RISK_PERCENT,
} = require('../src/services/strategy');

test('analysis refuses to calculate from fewer than 250 finalized candles', () => {
  assert.throws(() => analyzeCandles([]), { code: 'INSUFFICIENT_HISTORICAL_DATA' });
  assert.throws(
    () => analyzeCandles(new Array(MIN_CANDLES - 1)),
    { code: 'INSUFFICIENT_HISTORICAL_DATA' },
  );
});

test('position sizing uses exactly two percent of wallet balance at the stop', () => {
  const size = sizePosition({
    balance: 10_000,
    entryPrice: 100,
    stopLoss: 95,
    leverage: 1,
  });
  assert.equal(RISK_PERCENT, 2);
  assert.equal(size.riskBudgetUsd, 200);
  assert.equal(size.quantity, 40);
  assert.equal(size.margin, 4_000);
  assert.equal(size.maxRiskUsd, 200);
});

test('leverage changes required margin without changing the strict risk amount', () => {
  const size = sizePosition({
    balance: 10_000,
    entryPrice: 100,
    stopLoss: 99,
    leverage: 5,
  });
  assert.equal(size.quantity, 200);
  assert.equal(size.margin, 4_000);
  assert.equal(size.maxRiskUsd, 200);
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

test('entry requires seven aligned votes, volume above 1.5x, and 60% aligned book pressure', () => {
  const analysis = {
    buyVotes: 7,
    sellVotes: 2,
    volumeRatio: 1.51,
    orderBookPressure: { bidPercent: 60, askPercent: 40 },
  };
  assert.equal(getEntrySignal(analysis), 'LONG');
  assert.equal(getEntrySignal({
    ...analysis,
    orderBookPressure: { bidPercent: 40, askPercent: 60 },
  }), null);
  assert.equal(getEntrySignal({
    ...analysis,
    volumeRatio: 1.5,
    orderBookPressure: { bidPercent: 61, askPercent: 39 },
  }), null);
  assert.equal(getEntrySignal({
    buyVotes: 2,
    sellVotes: 7,
    volumeRatio: 1.6,
    orderBookPressure: { bidPercent: 39, askPercent: 61 },
  }), 'SHORT');
});

test('five-minute entries require the fifteen-minute signal to confirm the same direction', () => {
  const long = {
    buyVotes: 7,
    sellVotes: 2,
    volumeRatio: 1.51,
    orderBookPressure: { bidPercent: 60, askPercent: 40 },
  };
  const short = {
    buyVotes: 2,
    sellVotes: 7,
    volumeRatio: 1.51,
    orderBookPressure: { bidPercent: 40, askPercent: 60 },
  };
  assert.equal(getConfirmedEntrySignal(long, long), 'LONG');
  assert.equal(getConfirmedEntrySignal(long, short), null);
  assert.equal(getConfirmedEntrySignal(long, { ...long, volumeRatio: 1.5 }), null);
  assert.equal(getConfirmedEntrySignal({ ...short, volumeRatio: 1.5 }, short), null);
});
