const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { config, SYMBOLS } = require('../src/config');
const BotState = require('../src/models/BotState');
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

test('a fresh bot state defaults to enabled unless configuration explicitly disables it', () => {
  const state = new BotState();
  assert.equal(state.enabled, config.botEnabled);
  assert.equal(config.botEnabled, (process.env.BOT_ENABLED || 'true').toLowerCase() !== 'false');
  assert.equal(config.maxOpenTrades, 3);
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

test('TP1, TP2, and buffered stop-loss trigger the correct long and short exits', () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const long = {
    side: 'LONG',
    stopLoss: 98.5,
    tp1Price: 101.5,
    tp2Price: 103,
    takeProfit: 103,
  };
  assert.deepEqual(engine.getExit(long, { high: 101.5, low: 99 }), {
    reason: 'PARTIAL_TP1_FILLED',
  });
  assert.deepEqual(engine.getExit({ ...long, tp1Filled: true, stopLoss: 100.35 }, {
    high: 103,
    low: 101,
  }), { reason: 'TAKE_PROFIT' });
  assert.deepEqual(engine.getExit({ ...long, tp1Filled: true, stopLoss: 100.35 }, {
    high: 102,
    low: 100.35,
  }), { reason: 'STOP_LOSS' });

  const short = {
    side: 'SHORT',
    stopLoss: 101.5,
    tp1Price: 98.5,
    tp2Price: 97,
    takeProfit: 97,
  };
  assert.deepEqual(engine.getExit(short, { high: 101, low: 98.5 }), {
    reason: 'PARTIAL_TP1_FILLED',
  });
  assert.deepEqual(engine.getExit({ ...short, tp1Filled: true, stopLoss: 99.65 }, {
    high: 99,
    low: 97,
  }), { reason: 'TAKE_PROFIT' });
  assert.deepEqual(engine.getExit({ ...short, tp1Filled: true, stopLoss: 99.65 }, {
    high: 99.65,
    low: 98,
  }), { reason: 'STOP_LOSS' });
});

test('one R moves both long and short stops to fee-adjusted breakeven', async () => {
  const originalUpdate = PaperTrade.findOneAndUpdate;
  const updates = [];
  const trades = new Map();
  PaperTrade.findOneAndUpdate = async (filter, update) => {
    updates.push(update);
    const trade = trades.get(filter._id);
    const operation = update.$max || update.$min;
    for (const [field, value] of Object.entries(operation)) {
      trade[field] = update.$max
        ? Math.max(Number(trade[field] ?? -Infinity), value)
        : Math.min(Number(trade[field] ?? Infinity), value);
    }
    return trade;
  };
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    const long = {
      _id: 'long-trade',
      side: 'LONG',
      entryPrice: 100,
      initialStopLoss: 95,
      stopLoss: 95,
      highestPrice: 100,
      atr: 5 / 1.5,
    };
    const short = {
      _id: 'short-trade',
      side: 'SHORT',
      entryPrice: 100,
      initialStopLoss: 105,
      stopLoss: 105,
      lowestPrice: 100,
      atr: 5 / 1.5,
    };
    trades.set(long._id, long);
    trades.set(short._id, short);

    await engine.updateTradeProtection(long, { high: 105, low: 104 });
    await engine.updateTradeProtection(short, { high: 96, low: 95 });
    assert.equal(long.stopLoss, 100.35);
    assert.equal(short.stopLoss, 99.65);
    assert.deepEqual(updates[0].$max, { highestPrice: 105, stopLoss: 100.35 });
    assert.deepEqual(updates[1].$min, { lowestPrice: 95, stopLoss: 99.65 });
  } finally {
    PaperTrade.findOneAndUpdate = originalUpdate;
  }
});

test('partial profit triggers at +1.3R and trails the runner by 0.75 ATR after +1.8R', async () => {
  const originalUpdate = PaperTrade.findOneAndUpdate;
  const updates = [];
  const trades = new Map();
  PaperTrade.findOneAndUpdate = async (filter, update) => {
    updates.push(update);
    const trade = trades.get(filter._id);
    const operation = update.$max || update.$min;
    for (const [field, value] of Object.entries(operation)) {
      trade[field] = update.$max
        ? Math.max(Number(trade[field] ?? -Infinity), value)
        : Math.min(Number(trade[field] ?? Infinity), value);
    }
    return trade;
  };
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    const beforePartial = {
      _id: 'partial-trade',
      side: 'LONG',
      entryPrice: 100,
      initialStopLoss: 95,
      stopLoss: 95,
      highestPrice: 100,
      atr: 5 / 1.5,
      tp1Price: 106.5,
      tp2Price: 112.5,
      tp1Filled: false,
    };
    trades.set(beforePartial._id, beforePartial);
    const partialExit = await engine.getManagedExit(beforePartial, { high: 106.5, low: 102 });
    assert.deepEqual(partialExit, { reason: 'PARTIAL_TP1_FILLED' });
    assert.equal(beforePartial.stopLoss, 100.35);

    const runner = {
      ...beforePartial,
      _id: 'runner-trade',
      stopLoss: 103,
      highestPrice: 106.5,
      atr: 3,
      tp1Filled: true,
    };
    trades.set(runner._id, runner);
    await engine.updateTradeProtection(runner, { high: 110, low: 109 });
    assert.equal(runner.stopLoss, 107.75);
    assert.deepEqual(updates[1].$max, { highestPrice: 110, stopLoss: 107.75 });

    const stopExit = await engine.getManagedExit(runner, { high: 109, low: 107.75 });
    assert.deepEqual(stopExit, { reason: 'STOP_LOSS' });

    const shortRunner = {
      ...runner,
      _id: 'short-runner',
      side: 'SHORT',
      initialStopLoss: 105,
      stopLoss: 97,
      highestPrice: 100,
      lowestPrice: 93.5,
      tp2Price: 87.5,
    };
    trades.set(shortRunner._id, shortRunner);
    await engine.updateTradeProtection(shortRunner, { high: 91, low: 90.5 });
    assert.equal(shortRunner.stopLoss, 92.75);
    assert.deepEqual(updates[2].$min, { lowestPrice: 90.5, stopLoss: 92.75 });
  } finally {
    PaperTrade.findOneAndUpdate = originalUpdate;
  }
});

test('two consecutive recent symbol losses persist a six-hour cooldown', async () => {
  const originals = {
    findOne: PaperTrade.findOne,
    find: PaperTrade.find,
    updateOne: PaperTrade.updateOne,
  };
  const latestClosedAt = new Date(Date.now() - 10 * 60_000);
  let recentTrades = [
    { _id: 'latest-loss', pnlUsd: -2, closedAt: latestClosedAt },
    { _id: 'prior-loss', pnlUsd: -1, closedAt: new Date(latestClosedAt.getTime() - 60 * 60_000) },
  ];
  let query;
  let cooldownUpdate;
  PaperTrade.findOne = () => ({
    select: () => ({ sort: () => ({ lean: async () => null }) }),
  });
  PaperTrade.find = (filter) => {
    query = filter;
    return {
      select: () => ({
        sort: () => ({
          limit: () => ({ lean: async () => recentTrades }),
        }),
      }),
    };
  };
  PaperTrade.updateOne = async (filter, update) => {
    cooldownUpdate = { filter, update };
    return { matchedCount: 1 };
  };
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    assert.equal(await engine.isSymbolCoolingDown('ETHUSDT'), true);
    assert.equal(query.symbol, 'ETHUSDT');
    assert.equal(query.status, 'CLOSED');
    assert.ok(query.closedAt.$gte.getTime() > Date.now() - 12 * 60 * 60_000 - 1000);
    assert.deepEqual(cooldownUpdate.filter, { _id: 'latest-loss', status: 'CLOSED' });
    assert.equal(
      cooldownUpdate.update.$max.cooldownUntil.getTime() - latestClosedAt.getTime(),
      PaperTradingEngine.SYMBOL_LOSING_STREAK_COOLDOWN,
    );

    recentTrades = [recentTrades[0], { ...recentTrades[1], pnlUsd: 1 }];
    assert.equal(await engine.isSymbolCoolingDown('ETHUSDT'), false);
  } finally {
    PaperTrade.findOne = originals.findOne;
    PaperTrade.find = originals.find;
    PaperTrade.updateOne = originals.updateOne;
  }
});

test('fresh Binance depth keeps a quiet market ready and supplies a labeled midpoint quote', () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const candlesByInterval = new Map(config.entryIntervals.map((interval) => {
    const intervalMs = INTERVAL_MS[interval];
    const latestOpenTime = Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs;
    return [interval, Array.from({ length: 500 }, (_, index) => {
      const openTime = latestOpenTime - (499 - index) * intervalMs;
      return {
        time: new Date(openTime),
        openTime,
        closeTime: openTime + intervalMs - 1,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
        isFinal: true,
      };
    })];
  }));
  const staleTradeAt = new Date(Date.now() - 60_000);
  const orderBook = {
    symbol: 'ETHUSDT',
    bids: Array.from({ length: 20 }, (_, index) => ({ price: 99 - index, quantity: 1 })),
    asks: Array.from({ length: 20 }, (_, index) => ({ price: 101 + index, quantity: 1 })),
    bestBid: 99,
    bestAsk: 101,
    bidQuantity: 20,
    askQuantity: 20,
    bidNotional: 0,
    askNotional: 0,
    levelCount: 20,
    updatedAt: new Date(),
  };
  engine.feed.connected = true;
  for (const symbol of SYMBOLS) {
    for (const interval of config.entryIntervals) {
      engine.candleHistories.get(interval).set(symbol, candlesByInterval.get(interval));
      engine.candleErrors.get(interval).set(symbol, null);
    }
    engine.orderBooks.set(symbol, { ...orderBook, symbol });
    engine.prices.set(symbol, 100);
    engine.feedStates.set(symbol, {
      error: null,
      orderBookError: null,
      lastTradeAt: staleTradeAt,
      updatedAt: new Date(),
    });
  }

  assert.equal(engine.allMarketDataReady(), true);
  const market = engine.getMarketSnapshot('ETHUSDT');
  assert.equal(market.ready, true);
  assert.equal(market.price, 100);
  assert.equal(market.priceSource, 'ORDER_BOOK_MID');
  assert.ok(market.marketAgeMs < 15_000);

  engine.orderBooks.set('ETHUSDT', { ...orderBook, updatedAt: new Date(Date.now() - 60_000) });
  assert.equal(engine.allMarketDataReady(), false);
  assert.equal(engine.getMarketSnapshot('ETHUSDT').ready, false);
});

test('paper exits use a fresh Binance depth quote even when the last trade tick is quiet', async () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  engine.feed.connected = true;
  engine.orderBooks.set('ETHUSDT', {
    bids: Array.from({ length: 20 }, (_, index) => ({ price: 99 - index, quantity: 1 })),
    asks: Array.from({ length: 20 }, (_, index) => ({ price: 101 + index, quantity: 1 })),
    bestBid: 99,
    bestAsk: 101,
    updatedAt: new Date(),
  });
  engine.feedStates.set('ETHUSDT', { lastTradeAt: new Date(Date.now() - 60_000) });
  engine.closeTrade = async (...args) => args;
  const result = await engine.closeAtMarket({
    _id: 'paper-trade-test',
    symbol: 'ETHUSDT',
    side: 'LONG',
  }, 'MANUAL');

  assert.equal(result[0], 'paper-trade-test');
  assert.equal(result[1], 98.92575);
  assert.equal(result[2], 'MANUAL');
  assert.equal(result[3], 99);
});

test('paper trade schema persists protection state and one open position per symbol', () => {
  const trade = new PaperTrade();
  assert.equal(trade.entryFeeUsd, 0);
  assert.equal(trade.exitFeeUsd, 0);
  assert.equal(trade.totalFeesUsd, 0);
  assert.equal(trade.failureAnalysis, null);
  assert.equal(trade.cooldownUntil, null);
  assert.equal(trade.tp1Filled, false);
  assert.equal(trade.realizedPnl, 0);
  for (const field of [
    'initialQuantity', 'remainingQuantity', 'tp1Price', 'tp2Price',
    'atr', 'highestPrice', 'lowestPrice',
  ]) {
    assert.ok(PaperTrade.schema.path(field));
  }
  assert.ok(PaperTrade.schema.path('closeReason').enumValues.includes('EARLY_MOMENTUM_REVERSAL'));
  assert.ok(PaperTrade.schema.indexes().some(([fields, options]) =>
    fields.symbol === 1
    && options.unique
    && options.partialFilterExpression.status === 'OPEN'));
  assert.ok(!PaperTrade.schema.indexes().some(([, options]) =>
    options.name === 'one_open_paper_trade_per_account'));
});

test('partial take-profit realizes half, returns proportional margin, and locks at least +0.6R', async () => {
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
    status: 'OPEN',
    entryPrice: 100,
    initialStopLoss: 95,
    stopLoss: 95,
    entryFeeUsd: 0.15,
    exitFeeUsd: 0,
    totalFeesUsd: 0.15,
    quantity: 2,
    initialQuantity: 2,
    remainingQuantity: 2,
    margin: 500,
    executionCostUsd: 0,
    grossPnlUsd: 0,
    realizedPnl: 0,
    tp1Filled: false,
  };
  let tradeFilter;
  let tradeUpdate;
  let walletUpdate;
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  PaperTrade.findOne = () => ({ session: async () => trade });
  PaperTrade.updateOne = async (filter, update) => {
    tradeFilter = filter;
    tradeUpdate = update;
    Object.assign(trade, update.$set);
    return { matchedCount: 1 };
  };
  VirtualWallet.findOneAndUpdate = async (_filter, update) => {
    walletUpdate = update;
    return { balance: 10_004.84625 };
  };
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    const partial = await engine.closeTrade(
      trade._id,
      105,
      'PARTIAL_TP1_FILLED',
      105,
    );
    assert.equal(partial.isPartialTp1, true);
    assert.equal(partial.realizedPnlUsd, 4.84625);
    assert.equal(partial.feesDeductedUsd, 0.15375);
    assert.equal(partial.stopLoss, 103);
    assert.equal(tradeFilter.tp1Filled.$ne, true);
    assert.equal(tradeUpdate.$set.tp1Filled, true);
    assert.equal(tradeUpdate.$set.remainingQuantity, 1);
    assert.equal(tradeUpdate.$set.realizedPnl, 4.84625);
    assert.equal(walletUpdate.$inc.balance, 4.84625);
    assert.equal(walletUpdate.$inc.availableMargin, 254.92125);
    assert.equal(walletUpdate.$inc.inTradeMargin, -250);
    assert.equal(walletUpdate.$inc.winCount, 0);
    assert.equal(walletUpdate.$inc.lossCount, 0);
    assert.match(engine.getAuditLog()[0].message, /PARTIAL_TP1_FILLED/);
    assert.match(engine.getAuditLog()[0].message, /fees deducted 0\.15375000 USDT/);
    assert.match(engine.getAuditLog()[0].message, /new stop-loss 103/);

    const closed = await engine.closeTrade(trade._id, 103, 'STOP_LOSS', 103);
    assert.equal(closed.pnlUsd, 7.694);
    assert.equal(tradeUpdate.$set.realizedPnl, 7.694);
    assert.equal(tradeUpdate.$set.totalFeesUsd, 0.306);
    assert.equal(tradeUpdate.$set.remainingQuantity, 0);
    assert.equal(walletUpdate.$inc.balance, 2.84775);
    assert.equal(walletUpdate.$inc.totalRealizedPnl, 2.84775);
    assert.equal(walletUpdate.$inc.inTradeMargin, -250);
    assert.equal(walletUpdate.$inc.winCount, 1);
    assert.equal(walletUpdate.$inc.lossCount, 0);
  } finally {
    mongoose.startSession = originals.startSession;
    PaperTrade.findOne = originals.findOne;
    PaperTrade.updateOne = originals.updateTrade;
    VirtualWallet.findOneAndUpdate = originals.updateWallet;
  }
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
    countDocuments: PaperTrade.countDocuments,
    findOneAndUpdate: VirtualWallet.findOneAndUpdate,
    create: PaperTrade.create,
    fetch: global.fetch,
  };
  let walletUpdate;
  let notificationRequest;
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  PaperTrade.findOne = () => ({ session: async () => null });
  PaperTrade.countDocuments = () => ({ session: async () => 0 });
  global.fetch = async (url, options) => {
    notificationRequest = { url, options };
    return { ok: true, status: 200 };
  };
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
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      margin: 4_000,
      entryFeeUsd: 6,
      quantity: 40,
    });
    assert.equal(opened.id, 'paper-trade-test');
    assert.equal(notificationRequest.options.headers.Title, 'AuraAlgo: New Trade');
    assert.match(notificationRequest.options.body, /Direction: LONG/);
    assert.deepEqual(walletUpdate.filter, {
      _id: 'primary',
      availableMargin: { $gte: 4_006 },
    });
    assert.equal(walletUpdate.update.$inc.availableMargin, -4_006);
    assert.equal(walletUpdate.update.$inc.inTradeMargin, 4_000);
  } finally {
    mongoose.startSession = originals.startSession;
    PaperTrade.findOne = originals.findOne;
    PaperTrade.countDocuments = originals.countDocuments;
    VirtualWallet.findOneAndUpdate = originals.findOneAndUpdate;
    PaperTrade.create = originals.create;
    global.fetch = originals.fetch;
  }
});

test('transactional trade opening refuses to exceed the configured concurrent-position cap', async () => {
  const originals = {
    startSession: mongoose.startSession,
    findOne: PaperTrade.findOne,
    countDocuments: PaperTrade.countDocuments,
  };
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  PaperTrade.findOne = () => ({ session: async () => null });
  PaperTrade.countDocuments = () => ({ session: async () => config.maxOpenTrades });
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    const opened = await engine.openTrade({
      symbol: 'ETHUSDT',
      side: 'LONG',
      margin: 100,
      entryFeeUsd: 1,
    });
    assert.equal(opened, null);
  } finally {
    mongoose.startSession = originals.startSession;
    PaperTrade.findOne = originals.findOne;
    PaperTrade.countDocuments = originals.countDocuments;
  }
});

test('scanner opens at most three qualifying symbols in one candle scan', async () => {
  const originals = {
    findById: VirtualWallet.findById,
    countDocuments: PaperTrade.countDocuments,
    fetch: global.fetch,
  };
  const interval = '15m';
  const intervalMs = INTERVAL_MS[interval];
  const candleOpenTime = Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs;
  const openedSymbols = [];
  const openedTrades = [];
  VirtualWallet.findById = async () => ({ balance: 10_000, availableMargin: 10_000 });
  PaperTrade.countDocuments = async () => 0;
  global.fetch = async () => ({ ok: true, status: 200 });
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    engine.enabled = true;
    engine.dailyLossLimitReached = async () => false;
    engine.dailyConsecutiveLossLimitReached = async () => false;
    engine.isSymbolCoolingDown = async () => false;
    engine.refreshExecutionBook = async () => ({
      bids: Array.from({ length: 20 }, (_, index) => ({ price: 99 - index, quantity: 3 })),
      asks: Array.from({ length: 20 }, (_, index) => ({ price: 101 + index, quantity: 1 })),
      bestBid: 99,
      bestAsk: 101,
      bidQuantity: 60,
      askQuantity: 20,
      updatedAt: new Date(),
    });
    engine.openTrade = async (trade) => {
      openedSymbols.push(trade.symbol);
      openedTrades.push(trade);
      return trade;
    };
    for (const symbol of SYMBOLS) {
      engine.candleHistories.get(interval).set(symbol, Array.from({ length: 500 }, (_, index) => {
        const openTime = candleOpenTime - (499 - index) * intervalMs;
        const close = 100 + index * 0.1;
        return {
          time: new Date(openTime),
          openTime,
          closeTime: openTime + intervalMs - 1,
          open: close - 0.05,
          high: close + 10,
          low: close - 10,
          close,
          volume: index === 499 ? 200 : 100,
          isFinal: true,
        };
      }));
    }

    await engine.scanMarketsForEntry(candleOpenTime, interval);
    assert.deepEqual(openedSymbols, SYMBOLS.slice(0, config.maxOpenTrades));
    const firstTrade = openedTrades[0];
    const riskDistance = firstTrade.entryPrice - firstTrade.initialStopLoss;
    assert.ok(Math.abs((firstTrade.tp1Price - firstTrade.entryPrice) / riskDistance - 1.3) < 1e-8);
    assert.ok(Math.abs((firstTrade.tp2Price - firstTrade.entryPrice) / riskDistance - 2.5) < 1e-8);
  } finally {
    VirtualWallet.findById = originals.findById;
    PaperTrade.countDocuments = originals.countDocuments;
    global.fetch = originals.fetch;
  }
});

test('closing a losing stop updates wallet with net P&L and persists failure feedback', async () => {
  const originals = {
    startSession: mongoose.startSession,
    findOne: PaperTrade.findOne,
    updateTrade: PaperTrade.updateOne,
    updateWallet: VirtualWallet.findOneAndUpdate,
    fetch: global.fetch,
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
  let notificationRequest;
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  PaperTrade.findOne = () => ({ session: async () => trade });
  PaperTrade.updateOne = async (_filter, update) => {
    tradeUpdate = update;
    return { matchedCount: 1 };
  };
  global.fetch = async (url, options) => {
    notificationRequest = { url, options };
    return { ok: true, status: 200 };
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notificationRequest.options.headers.Title, 'AuraAlgo: Trade Closed');
    assert.match(notificationRequest.options.body, /Exit Reason: STOP_LOSS/);
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
    global.fetch = originals.fetch;
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

test('daily consecutive-loss breaker counts only the latest closed losses in UTC day', async () => {
  const originalFind = PaperTrade.find;
  let query;
  let requestedSort;
  let rows = [{ pnlUsd: -2 }, { pnlUsd: -1 }];
  PaperTrade.find = (filter) => {
    query = filter;
    return {
      select: () => ({
        sort: (sort) => {
          requestedSort = sort;
          return { lean: async () => rows };
        },
      }),
    };
  };
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    assert.equal(await engine.dailyConsecutiveLossLimitReached(), true);
    assert.equal(query.status, 'CLOSED');
    assert.equal(new Date(query.closedAt.$gte).toISOString().slice(11), '00:00:00.000Z');
    assert.deepEqual(requestedSort, { closedAt: 1 });

    rows = [{ pnlUsd: -2 }, { pnlUsd: -1 }, { pnlUsd: 0.5 }];
    assert.equal(await engine.dailyConsecutiveLossLimitReached(), true, 'the circuit breaker remains latched after it is reached');
    rows = [{ pnlUsd: -2 }, { pnlUsd: 0.5 }, { pnlUsd: -1 }];
    assert.equal(await engine.dailyConsecutiveLossLimitReached(), false);
    rows = [{ pnlUsd: -2 }];
    assert.equal(await engine.dailyConsecutiveLossLimitReached(), false);
  } finally {
    PaperTrade.find = originalFind;
  }
});

test('daily consecutive-loss breaker stops the scanner from opening new trades', async () => {
  const originalExists = PaperTrade.exists;
  PaperTrade.exists = async () => false;
  try {
    const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
    const interval = '15m';
    const intervalMs = INTERVAL_MS[interval];
    const candleOpenTime = Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs;
    for (const symbol of SYMBOLS) {
      engine.candleHistories.get(interval).set(symbol, Array.from({ length: 500 }, (_, index) => {
        const openTime = candleOpenTime - (499 - index) * intervalMs;
        return {
          time: new Date(openTime),
          openTime,
          closeTime: openTime + intervalMs - 1,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 10,
          isFinal: true,
        };
      }));
    }
    engine.dailyLossLimitReached = async () => false;
    engine.dailyConsecutiveLossLimitReached = async () => true;

    await engine.scanMarketsForEntry(candleOpenTime, interval);
    assert.match(engine.getAuditLog()[0].message, /consecutive losing trades today/);
  } finally {
    PaperTrade.exists = originalExists;
  }
});

test('market APIs fail with an explicit 503 while real feed data is unavailable', async () => {
  const engine = new PaperTradingEngine({ logger: { info() {}, warn() {}, error() {} } });
  const originalConsoleError = console.error;
  let errorLogCount = 0;
  console.error = () => { errorLogCount += 1; };
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
    assert.equal(errorLogCount, 0, 'expected unavailable market data should not log a server stack on every poll');
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
    console.error = originalConsoleError;
  }
});
