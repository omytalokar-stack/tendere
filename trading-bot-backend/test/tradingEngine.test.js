const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { config } = require('../src/config');
const PaperTrade = require('../src/models/PaperTrade');
const VirtualWallet = require('../src/models/VirtualWallet');
const PaperTradingEngine = require('../src/services/paperTradingEngine');
const createApp = require('../src/app');

const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

test('virtual wallet defaults to the configured paper balance', () => {
  const wallet = new VirtualWallet();
  assert.equal(wallet.balance, config.initialBalance);
  assert.equal(wallet.availableMargin, config.initialBalance);
  assert.equal(wallet.inTradeMargin, 0);
  assert.equal(wallet.totalRealizedPnl, 0);
  assert.equal(wallet.winCount, 0);
  assert.equal(wallet.lossCount, 0);
});

test('a closed candle crossing both thresholds classifies stop-loss first', () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const exit = engine.getExit(
    { side: 'LONG', stopLoss: 95, takeProfit: 110 },
    { open: 100, high: 111, low: 94 }
  );
  assert.deepEqual(exit, { reason: 'STOP_LOSS' });
});

test('a closed candle crossing a stop-loss returns no assumed fill price', () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const exit = engine.getExit(
    { side: 'SHORT', stopLoss: 105, takeProfit: 90 },
    { open: 107, high: 108, low: 88 }
  );
  assert.deepEqual(exit, { reason: 'STOP_LOSS' });
});

test('paper trade schema persists fees, stop-loss feedback, and one account-wide open position', () => {
  const trade = new PaperTrade();
  assert.equal(trade.entryFeeUsd, 0);
  assert.equal(trade.exitFeeUsd, 0);
  assert.equal(trade.totalFeesUsd, 0);
  assert.equal(trade.failureAnalysis, null);
  assert.equal(trade.cooldownUntil, null);
  assert.ok(PaperTrade.schema.path('closeReason').enumValues.includes('EARLY_MOMENTUM_REVERSAL'));
  assert.ok(PaperTrade.schema.indexes().some(([, options]) =>
    options.name === 'one_open_paper_trade_per_account'
    && options.unique
    && options.partialFilterExpression.status === 'OPEN'));
});

test('realized paper P&L deducts both 0.075% taker fees from gross P&L', () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const result = engine.calculateTradeResult({
    side: 'LONG',
    entryPrice: 100,
    quantity: 2,
    entryFeeUsd: 0.15,
  }, 110);
  assert.equal(result.grossPnlUsd, 20);
  assert.equal(result.entryFeeUsd, 0.15);
  assert.equal(result.exitFeeUsd, 0.165);
  assert.equal(result.totalFeesUsd, 0.315);
  assert.equal(result.netPnlUsd, 19.685);
});

test('opening a position reserves its entry fee from available margin immediately', async () => {
  const originals = {
    startSession: mongoose.startSession,
    findOne: PaperTrade.findOne,
    findOneAndUpdate: VirtualWallet.findOneAndUpdate,
    create: PaperTrade.create,
  };
  let walletUpdate;
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  PaperTrade.findOne = () => ({ session: async () => null });
  VirtualWallet.findOneAndUpdate = async (filter, update) => {
    walletUpdate = { filter, update };
    return { _id: 'primary' };
  };
  PaperTrade.create = async ([trade]) => [{ ...trade, id: 'paper-trade-test' }];
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    const opened = await engine.openTrade({
      symbol: 'ETHUSDT',
      side: 'LONG',
      margin: 4_000,
      entryFeeUsd: 6,
      quantity: 40,
    });
    assert.equal(opened.id, 'paper-trade-test');
    assert.deepEqual(walletUpdate.filter, {
      _id: 'primary',
      availableMargin: { $gte: 4_006 },
    });
    assert.equal(walletUpdate.update.$inc.availableMargin, -4_006);
    assert.equal(walletUpdate.update.$inc.inTradeMargin, 4_000);
  } finally {
    mongoose.startSession = originals.startSession;
    PaperTrade.findOne = originals.findOne;
    VirtualWallet.findOneAndUpdate = originals.findOneAndUpdate;
    PaperTrade.create = originals.create;
  }
});

test('closing a losing stop updates wallet with net P&L and persists failure feedback', async () => {
  const originals = {
    startSession: mongoose.startSession,
    findOne: PaperTrade.findOne,
    updateTrade: PaperTrade.updateOne,
    updateWallet: VirtualWallet.findOneAndUpdate,
  };
  const trade = {
    _id: 'paper-trade-test',
    id: 'paper-trade-test',
    symbol: 'ETHUSDT',
    side: 'LONG',
    entryPrice: 100,
    entryFeeUsd: 0.15,
    quantity: 2,
    margin: 500,
    executionCostUsd: 0,
  };
  let tradeUpdate;
  let walletUpdate;
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  PaperTrade.findOne = () => ({ session: async () => trade });
  PaperTrade.updateOne = async (_filter, update) => {
    tradeUpdate = update;
    return { matchedCount: 1 };
  };
  VirtualWallet.findOneAndUpdate = async (_filter, update) => {
    walletUpdate = update;
    return { balance: 9_979.715 };
  };
  try {
    const engine = new PaperTradingEngine({
      logger: { info() {}, warn() {}, error() {} },
    });
    const failureAnalysis = {
      volumeRatio: 1.8,
      indicators: [{ name: 'RSI-14', value: 70, vote: 'SELL' }],
    };
    const closed = await engine.closeTrade(
      trade._id,
      90,
      'STOP_LOSS',
      90.0675,
      failureAnalysis,
    );
    assert.equal(closed.grossPnlUsd, -20);
    assert.equal(closed.totalFeesUsd, 0.285);
    assert.equal(closed.pnlUsd, -20.285);
    assert.equal(tradeUpdate.$set.pnlUsd, -20.285);
    assert.equal(tradeUpdate.$set.failureAnalysis, failureAnalysis);
    assert.equal(
      tradeUpdate.$set.cooldownUntil.getTime() - tradeUpdate.$set.closedAt.getTime(),
      INTERVAL_MS[config.candleInterval] * 3,
    );
    assert.equal(walletUpdate.$inc.balance, -20.285);
    assert.equal(walletUpdate.$inc.totalRealizedPnl, -20.285);
    assert.equal(walletUpdate.$inc.availableMargin, 479.865);
    assert.equal(walletUpdate.$inc.inTradeMargin, -500);
  } finally {
    mongoose.startSession = originals.startSession;
    PaperTrade.findOne = originals.findOne;
    PaperTrade.updateOne = originals.updateTrade;
    VirtualWallet.findOneAndUpdate = originals.updateWallet;
  }
});

test('stop-loss cooldown lasts exactly three configured candle intervals', () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const closedAt = new Date('2026-01-01T00:00:00.000Z');
  const cooldownUntil = engine.getCooldownUntil(closedAt);
  const intervalMs = INTERVAL_MS[config.candleInterval];
  assert.equal(cooldownUntil.getTime() - closedAt.getTime(), intervalMs * 3);
  if (config.candleInterval === '15m') assert.equal(intervalMs * 3, 45 * 60_000);
});

test('market APIs fail with an explicit 503 while real feed data is unavailable', async () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const server = createApp(engine).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const [statusResponse, candleResponse, auditResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/market/status`),
      fetch(`http://127.0.0.1:${port}/api/market/ETHUSDT/candles`),
      fetch(`http://127.0.0.1:${port}/api/bot/audit`),
    ]);
    assert.equal(statusResponse.status, 503);
    assert.match((await statusResponse.json()).error, /^DATA_FEED_OFFLINE:/);
    assert.equal(candleResponse.status, 503);
    assert.match((await candleResponse.json()).error, /^DATA_FEED_OFFLINE:/);
    assert.equal(auditResponse.status, 200);
    assert.deepEqual((await auditResponse.json()).events, []);
    const liveResponse = await fetch(`http://127.0.0.1:${port}/api/health/live`);
    const livePayload = await liveResponse.json();
    assert.equal(liveResponse.status, 200);
    assert.equal(livePayload.status, 'ok');
    assert.ok(Number.isFinite(Date.parse(livePayload.timestamp)));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
