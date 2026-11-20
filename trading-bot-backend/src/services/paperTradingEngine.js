const mongoose = require('mongoose');
const { config, SYMBOLS } = require('../config');
const BotState = require('../models/BotState');
const DailyRiskState = require('../models/DailyRiskState');
const PaperTrade = require('../models/PaperTrade');
const VirtualWallet = require('../models/VirtualWallet');
const BinanceFeed = require('./binanceFeed');
const {
  analyzeCandles,
  getEntrySignal,
  getConfirmedEntrySignal,
  rankOpportunities,
  sizePosition,
  getHtfEntryContext,
  MAX_HTF_SOURCE_CANDLES,
  MIN_CANDLES,
} = require('./strategy');
const { REQUIRED_CANDLES } = require('./binanceFeed');
const {
  notifyTradeOpened,
  notifyTradeClosed,
  notifyDailyLossLimit,
} = require('./notificationAlerts');
const TAKER_FEE_RATE = 0;
const STANDARD_ALLOCATION_PERCENT = 25;
const POSITION_MARGIN_FRACTION = 0.25;
const MAX_POSITION_MARGIN_USDT = 2_500;
const A_PLUS_POSITION_MARGIN_FRACTION = 0.35;
const A_PLUS_MAX_POSITION_MARGIN_USDT = 3_500;
const STOP_LOSS_ATR_MULTIPLE = 1.5;
const TP1_ATR_MULTIPLE = 1.5;
const TP2_ATR_MULTIPLE = 3;
const DAILY_LOSS_EQUITY_FRACTION = 0.05;
const DAILY_CONSECUTIVE_LOSS_LIMIT = 3;
const MAX_OPPORTUNITIES_PER_SCAN = 2;
const COOLDOWN_CANDLES = 3;
const SYMBOL_LOSING_STREAK_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const SYMBOL_LOSING_STREAK_COOLDOWN = 6 * 60 * 60 * 1000;
const MAX_MARKET_DATA_AGE_MS = 15_000;
const CANDLE_INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

function round(value, places = 8) {
  return Number(value.toFixed(places));
}

function unavailableAnalysis() {
  return {
    htf1hTrend: 'NEUTRAL',
    htf4hTrend: 'NEUTRAL',
    htfAlignment: 'STANDARD',
    allocationPercent: 25,
    counterTrendBlocked: false,
    htf1h: { trend: 'NEUTRAL', close: null, ema20: null, ema50: null, ema200: null, candleCount: 0 },
    htf4h: { trend: 'NEUTRAL', close: null, ema20: null, ema50: null, ema200: null, candleCount: 0 },
    side: null,
    buyVotes: 0,
    sellVotes: 0,
    totalVotes: 0,
    bullishCount: 0,
    bearishCount: 0,
    atr: 0,
    rsi: 0,
    adx: 0,
    vwap: 0,
    supertrend: { value: 0, direction: 'NEUTRAL' },
    currentVolume: 0,
    averageVolume: 0,
    volumeRatio: 0,
    volumeSpikeRatio: 0,
    opportunityScore: 0,
    indicators: [],
  };
}

class PaperTradingEngine {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.running = false;
    this.enabled = false;
    this.prices = new Map();
    this.tickCounts = new Map(SYMBOLS.map((symbol) => [symbol, 0]));
    this.candles = new Map(SYMBOLS.map((symbol) => [symbol, []]));
    this.candleHistories = new Map(config.entryIntervals.map((interval) => [
      interval,
      interval === config.candleInterval
        ? this.candles
        : new Map(SYMBOLS.map((symbol) => [symbol, []])),
    ]));
    this.candleErrors = new Map(config.entryIntervals.map((interval) => [
      interval,
      new Map(SYMBOLS.map((symbol) => [
        symbol,
        `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: awaiting initial synchronization`,
      ])),
    ]));
    this.lastProcessedCandle = new Map();
    this.lastProcessedByInterval = new Map();
    this.lastEntryScanCandleOpenTime = new Map(config.entryIntervals.map((interval) => [interval, 0]));
    this.orderBooks = new Map();
    this.pendingExits = new Map();
    this.closingTrades = new Set();
    this.dailyLossAlertDate = null;
    this.auditLog = [];
    this.feedStates = new Map(SYMBOLS.map((symbol) => [symbol, {
      error: `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: awaiting initial synchronization`,
      orderBookError: 'ORDERBOOK_DISCONNECTED',
      updatedAt: null,
    }]));
    this.feed = new BinanceFeed({
      onCandle: (symbol, candles, options) => this.handleCandles(symbol, candles, options),
      onPrice: (symbol, price, timestamp) => {
        this.prices.set(symbol, price);
        this.tickCounts.set(symbol, (this.tickCounts.get(symbol) || 0) + 1);
        const state = this.feedStates.get(symbol);
        if (state) state.lastTradeAt = timestamp;
        this.handlePrice(symbol).catch((error) =>
          this.logger.error('Live tick processing failed', { symbol, error }));
      },
      onOrderBook: (symbol, orderBook) => this.orderBooks.set(symbol, orderBook),
      onFeedState: (symbol, update, interval) => this.updateFeedState(symbol, update, interval),
      logger,
    });
  }

  updateFeedState(symbol, update, interval = config.candleInterval) {
    const previous = this.feedStates.get(symbol) || {};
    if (update.error && update.error !== previous.error) {
      this.recordAudit('FEED', symbol, update.error);
    }
    if (update.orderBookError && update.orderBookError !== previous.orderBookError) {
      this.recordAudit('FEED', symbol, update.orderBookError);
    }
    if (update.error !== undefined) {
      this.candleErrors.get(interval)?.set(symbol, update.error);
    }
    this.feedStates.set(symbol, {
      ...previous,
      ...update,
      ...(update.orderBookError === undefined ? { orderBookError: previous.orderBookError } : {}),
      updatedAt: new Date(),
    });
  }

  recordAudit(type, symbol, message) {
    this.auditLog.unshift({
      id: `${Date.now()}-${this.auditLog.length}`,
      time: new Date().toISOString(),
      type,
      symbol: symbol || null,
      message,
    });
    if (this.auditLog.length > 100) this.auditLog.length = 100;
  }

  async initializeWallet() {
    return VirtualWallet.findOneAndUpdate(
      { _id: 'primary' },
      {
        $setOnInsert: {
          balance: config.initialBalance,
          availableMargin: config.initialBalance,
          inTradeMargin: 0,
          totalRealizedPnl: 0,
          winCount: 0,
          lossCount: 0,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }

  async reconcileWalletWithOpenTrades() {
    const wallet = await VirtualWallet.findById('primary').lean();
    if (!wallet) throw new Error('Virtual wallet has not been initialized');
    const openTrades = await PaperTrade.find({ status: 'OPEN' })
      .select('margin initialQuantity remainingQuantity quantity')
      .lean();
    const inTradeMargin = round(openTrades.reduce((total, trade) => {
      const initialQuantity = Number(trade.initialQuantity || trade.quantity);
      const remainingQuantity = Number(trade.remainingQuantity ?? trade.quantity);
      const margin = Number(trade.margin);
      if (![initialQuantity, remainingQuantity, margin].every(Number.isFinite)
        || initialQuantity <= 0
        || remainingQuantity < 0
        || remainingQuantity > initialQuantity
        || margin < 0) {
        throw new Error(`Cannot reconcile wallet: invalid open-trade margin data for ${trade._id}`);
      }
      return total + margin * remainingQuantity / initialQuantity;
    }, 0));
    const balance = Number(wallet.balance);
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error('Cannot reconcile wallet: invalid paper balance');
    }
    const availableMargin = round(Math.max(0, balance - inTradeMargin));
    if (Math.abs(Number(wallet.inTradeMargin) - inTradeMargin) < 1e-8
      && Math.abs(Number(wallet.availableMargin) - availableMargin) < 1e-8) {
      return wallet;
    }

    const updatedWallet = await VirtualWallet.findOneAndUpdate(
      { _id: 'primary' },
      { $set: { availableMargin, inTradeMargin } },
      { returnDocument: 'after' },
    );
    if (!updatedWallet) throw new Error('Cannot reconcile wallet: primary wallet disappeared');
    this.logger.warn('Reconciled paper wallet margin with open positions', {
      previousAvailableMargin: wallet.availableMargin,
      previousInTradeMargin: wallet.inTradeMargin,
      availableMargin,
      inTradeMargin,
      openTradeCount: openTrades.length,
    });
    return updatedWallet;
  }

  async initializeDailyRiskState(now = new Date()) {
    const key = now.toISOString().slice(0, 10);
    const existing = await DailyRiskState.findById(key).lean();
    if (existing) return existing;
    const wallet = await VirtualWallet.findById('primary').lean();
    if (!wallet) throw new Error('Virtual wallet has not been initialized');

    const dayStart = new Date(`${key}T00:00:00.000Z`);
    const [closedTrades, recentTrades] = await Promise.all([
      PaperTrade.find({ status: 'CLOSED', closedAt: { $gte: dayStart } })
        .select('pnlUsd')
        .lean(),
      PaperTrade.find({ status: 'CLOSED', closedAt: { $gte: dayStart } })
        .select('pnlUsd closedAt')
        .sort({ closedAt: -1 })
        .lean(),
    ]);
    const dailyNetRealizedPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.pnlUsd || 0), 0);
    let consecutiveLosses = 0;
    for (const trade of recentTrades) {
      if (trade.pnlUsd >= 0) break;
      consecutiveLosses += 1;
    }
    const dayStartEquity = Math.max(0, Number(wallet.balance) - dailyNetRealizedPnl);
    const pauseReason = consecutiveLosses >= DAILY_CONSECUTIVE_LOSS_LIMIT
      ? 'CONSECUTIVE_LOSSES'
      : dailyNetRealizedPnl <= -(dayStartEquity * DAILY_LOSS_EQUITY_FRACTION)
        ? 'DAILY_EQUITY_LOSS'
        : null;
    return DailyRiskState.findOneAndUpdate(
      { _id: key },
      {
        $setOnInsert: {
          dayStartEquity,
          dailyNetRealizedPnl,
          consecutiveLosses,
          paused: Boolean(pauseReason),
          pauseReason,
          pausedAt: pauseReason ? now : null,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
  }

  async getOrCreateBotState() {
    return BotState.findOneAndUpdate(
      { _id: 'primary' },
      { $setOnInsert: { enabled: config.botEnabled, updatedBy: 'system' } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }

  async start({ enabled = true } = {}) {
    this.enabled = enabled;
    if (this.running) return;
    this.running = true;
    try {
      await this.initializeWallet();
      await this.reconcileWalletWithOpenTrades();
      await this.initializeDailyRiskState();
      await this.feed.start();
    } catch (error) {
      this.running = false;
      this.feed.stop();
      throw error;
    }
    this.logger.info('Paper trading engine started', {
      symbols: SYMBOLS,
      interval: config.candleInterval,
      entryIntervals: config.entryIntervals,
      maxPositionMargin: MAX_POSITION_MARGIN_USDT,
      positionMarginFraction: POSITION_MARGIN_FRACTION,
      leverage: config.leverage,
      dailyLossEquityFraction: DAILY_LOSS_EQUITY_FRACTION,
      dailyConsecutiveLossLimit: DAILY_CONSECUTIVE_LOSS_LIMIT,
    });
    this.recordAudit('ENGINE', null, 'Paper trading engine started');
  }

  stop() {
    this.enabled = false;
    this.recordAudit('ENGINE', null, 'Automated entries paused; open positions remain monitored');
    this.logger.info('Paper trading entries paused; open positions remain monitored');
  }

  shutdown() {
    this.running = false;
    this.feed.stop();
    this.logger.info('Paper trading engine stopped');
  }

  async handleCandles(symbol, incomingCandles, {
    historical,
    final = true,
    triggerOnly = false,
    interval = config.candleInterval,
  }) {
    const history = this.candleHistories.get(interval)?.get(symbol);
    if (!history) return;

    for (const candle of incomingCandles) {
      if (candle.isFinal !== true && !triggerOnly) continue;
      if (historical) {
        const existingIndex = history.findIndex((item) => item.openTime === candle.openTime);
        if (existingIndex >= 0) history[existingIndex] = candle;
        else history.push(candle);
        history.sort((a, b) => a.openTime - b.openTime);
        const historyLimit = interval === '15m' ? MAX_HTF_SOURCE_CANDLES : REQUIRED_CANDLES;
        if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
        if (interval === config.candleInterval) {
          this.lastProcessedCandle.set(symbol, Math.max(this.lastProcessedCandle.get(symbol) || 0, candle.openTime));
        }
        continue;
      }

      const openTrade = await PaperTrade.findOne({ symbol, status: 'OPEN' });
      if (interval === config.candleInterval && openTrade && candle.isFinal !== true) {
        const exit = await this.getManagedExit(openTrade, candle);
        if (exit) {
          this.pendingExits.set(symbol, exit.reason);
          const closed = await this.closeAtMarket(openTrade, exit.reason);
          if (closed) this.pendingExits.delete(symbol);
        }
        continue;
      }
      if (!final && !triggerOnly) continue;
      const intervalKey = `${interval}:${symbol}`;
      const priorTimestamp = this.lastProcessedByInterval.get(intervalKey) || 0;
      const existingIndex = history.findIndex((item) => item.openTime === candle.openTime);
      if (candle.isFinal === true) {
        if (existingIndex >= 0) history[existingIndex] = candle;
        else history.push(candle);
      }
      history.sort((a, b) => a.openTime - b.openTime);
      const historyLimit = interval === '15m' ? MAX_HTF_SOURCE_CANDLES : REQUIRED_CANDLES;
      if (history.length > historyLimit) history.splice(0, history.length - historyLimit);

      if (candle.isFinal !== true) continue;
      if (candle.openTime <= priorTimestamp) continue;

      if (!this.running) continue;
      await this.processClosedCandle(symbol, candle, history, interval);
      this.lastProcessedByInterval.set(intervalKey, candle.openTime);
      if (interval === config.candleInterval) {
        this.lastProcessedCandle.set(symbol, candle.openTime);
      }
    }

    if (historical && interval === config.candleInterval) {
      const openTrade = await PaperTrade.findOne({ symbol, status: 'OPEN' });
      let historicalExit = null;
      if (openTrade) {
        const laterCandles = history
          .filter((candle) => new Date(candle.time).getTime() > new Date(openTrade.openedAt).getTime());
        for (const candle of laterCandles) {
          historicalExit = await this.getManagedExit(openTrade, candle);
          if (historicalExit) break;
        }
      }
      if (historicalExit) {
        this.pendingExits.set(symbol, historicalExit.reason);
      }
    }
  }

  async handlePrice(symbol) {
    const reason = this.pendingExits.get(symbol);
    if (!reason || !this.feed.connected) return;
    const trade = await PaperTrade.findOne({ symbol, status: 'OPEN' });
    if (!trade) {
      this.pendingExits.delete(symbol);
      return;
    }
    const closed = await this.closeAtMarket(trade, reason);
    if (closed) this.pendingExits.delete(symbol);
  }

  async processClosedCandle(symbol, candle, history, interval = config.candleInterval) {
    const openTrade = await PaperTrade.findOne({ symbol, status: 'OPEN' });
    if (openTrade) {
      if (interval === config.candleInterval) {
        const exit = await this.getManagedExit(openTrade, candle);
        if (exit) {
          this.pendingExits.set(symbol, exit.reason);
          const closed = await this.closeAtMarket(openTrade, exit.reason);
          if (closed) this.pendingExits.delete(symbol);
        }
      }
      return;
    }

    if (!this.enabled) return;
    if (!this.allMarketDataReady()) return;
    await this.scanMarketsForEntry(candle.openTime, interval);
  }

  async scanMarketsForEntry(candleOpenTime, interval = config.candleInterval) {
    const lastScanTime = this.lastEntryScanCandleOpenTime.get(interval) || 0;
    if (candleOpenTime <= lastScanTime) return;
    const intervalCandles = this.candleHistories.get(interval);
    const histories = new Map(SYMBOLS.map((symbol) => [symbol, intervalCandles?.get(symbol) || []]));
    if (!SYMBOLS.every((symbol) => {
      const history = histories.get(symbol);
      return history.length >= REQUIRED_CANDLES
        && history[history.length - 1].openTime === candleOpenTime
        && this.isCandleHistoryComplete(history);
    })) return;

    this.lastEntryScanCandleOpenTime.set(interval, candleOpenTime);
    const confirmationHistories = interval === '5m'
      ? new Map(SYMBOLS.map((symbol) => [
        symbol,
        this.candleHistories.get('15m')?.get(symbol) || [],
      ]))
      : null;
    if (confirmationHistories && !SYMBOLS.every((symbol) =>
      this.isCandleHistoryComplete(confirmationHistories.get(symbol)))) return;
    if (await this.dailyCircuitBreakerReached()) return;

    let openTradeCount = await PaperTrade.countDocuments({ status: 'OPEN' });
    if (openTradeCount >= config.maxOpenTrades) return;

    const initializedWallet = await VirtualWallet.findById('primary');
    if (!initializedWallet) throw new Error('Virtual wallet has not been initialized');

    const opportunities = [];
    for (const symbol of SYMBOLS) {
      const history = histories.get(symbol);
      const confirmationAnalysis = confirmationHistories
        ? analyzeCandles(confirmationHistories.get(symbol))
        : null;
      const analysis = analyzeCandles(history, confirmationAnalysis
        ? {
          htf1h: confirmationAnalysis.htf1h,
          htf4h: confirmationAnalysis.htf4h,
        }
        : null);
      const direction = confirmationAnalysis
        ? getConfirmedEntrySignal(analysis, confirmationAnalysis)
        : getEntrySignal(analysis);
      if (!direction) continue;

      opportunities.push({
        symbol,
        direction,
        analysis,
        opportunityScore: analysis.volumeSpikeRatio * analysis.adx,
      });
    }

    const rankedOpportunities = rankOpportunities(opportunities, MAX_OPPORTUNITIES_PER_SCAN);
    for (const opportunity of rankedOpportunities) {
      if (openTradeCount >= config.maxOpenTrades) break;
      const { symbol, direction, analysis } = opportunity;
      if (await this.isSymbolCoolingDown(symbol)) continue;
      const lastTradeAt = this.feedStates.get(symbol)?.lastTradeAt;
      const entryQuote = this.prices.get(symbol);
      if (!this.isTradeQuoteFresh(symbol, entryQuote, lastTradeAt)) continue;

      const stopDistance = analysis.atr * STOP_LOSS_ATR_MULTIPLE;
      if (!Number.isFinite(stopDistance) || stopDistance <= 0) continue;
      const entryPrice = entryQuote;
      const stopLoss = direction === 'LONG'
        ? entryPrice - stopDistance
        : entryPrice + stopDistance;
      const tp1Price = direction === 'LONG'
        ? entryPrice + analysis.atr * TP1_ATR_MULTIPLE
        : entryPrice - analysis.atr * TP1_ATR_MULTIPLE;
      const tp2Price = direction === 'LONG'
        ? entryPrice + analysis.atr * TP2_ATR_MULTIPLE
        : entryPrice - analysis.atr * TP2_ATR_MULTIPLE;
      if (stopLoss <= 0 || tp1Price <= 0 || tp2Price <= 0) continue;

      const wallet = await VirtualWallet.findById('primary');
      if (!wallet) throw new Error('Virtual wallet has not been initialized');
      const allocationPercent = analysis.allocationPercent;
      const isAPlus = analysis.htfAlignment === 'ALIGNED_1H_4H';
      const position = sizePosition({
        availableMargin: wallet.availableMargin,
        entryPrice,
        allocationPercent,
        maxAllocation: isAPlus ? A_PLUS_MAX_POSITION_MARGIN_USDT : MAX_POSITION_MARGIN_USDT,
      });
      if (!this.enabled
        || position.margin > wallet.availableMargin
        || position.quantity <= 0) continue;

      const openedTrade = await this.openTrade({
        symbol,
        side: direction,
        entryPrice,
        entryQuote,
        initialStopLoss: stopLoss,
        atr: analysis.atr,
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        executionCostUsd: 0,
        entryFeeUsd: 0,
        exitFeeUsd: 0,
        totalFeesUsd: 0,
        initialQuantity: position.quantity,
        remainingQuantity: position.quantity,
        tp1Price,
        tp2Price,
        tp1Filled: false,
        realizedPnl: 0,
        htf1hTrend: analysis.htf1hTrend,
        htf4hTrend: analysis.htf4hTrend,
        htfAlignment: analysis.htfAlignment,
        allocationPercent: position.allocationPercent,
        quantity: position.quantity,
        margin: position.margin,
        leverage: config.leverage,
        stopLoss,
        takeProfit: tp2Price,
        strategy: `${interval}${confirmationHistories ? ' + 15m confirmed' : ''}: ${analysis.strategy} (${direction === 'LONG' ? analysis.bullishCount : analysis.bearishCount}/${analysis.totalVotes}) ${analysis.htfAlignment}`,
        openedAt: new Date(),
      });
      if (openedTrade) openTradeCount += 1;
    }
  }

  async isSymbolCoolingDown(symbol, now = new Date()) {
    const recentTrades = await PaperTrade.find({
      symbol,
      status: 'CLOSED',
      closedAt: { $gte: new Date(now.getTime() - SYMBOL_LOSING_STREAK_LOOKBACK_MS) },
    })
      .select('_id pnlUsd closedAt')
      .sort({ closedAt: -1 })
      .limit(2)
      .lean();
    if (recentTrades.length >= 2 && recentTrades.every((trade) => trade.pnlUsd < 0)) {
      const cooldownUntil = new Date(
        new Date(recentTrades[0].closedAt).getTime() + SYMBOL_LOSING_STREAK_COOLDOWN,
      );
      if (cooldownUntil > now) {
        await PaperTrade.updateOne(
          { _id: recentTrades[0]._id, status: 'CLOSED' },
          { $max: { cooldownUntil } },
        );
        return true;
      }
    }

    const activeCooldown = await PaperTrade.findOne({
      symbol,
      status: 'CLOSED',
      cooldownUntil: { $gt: now },
    }).select('cooldownUntil').sort({ cooldownUntil: -1 }).lean();
    return Boolean(activeCooldown);
  }

  isTradeQuoteFresh(symbol, price = this.prices.get(symbol), timestamp = this.feedStates.get(symbol)?.lastTradeAt) {
    return Number.isFinite(price)
      && price > 0
      && timestamp instanceof Date
      && Date.now() - timestamp.getTime() >= 0
      && Date.now() - timestamp.getTime() <= MAX_MARKET_DATA_AGE_MS;
  }

  isOrderBookFresh(orderBook) {
    return Boolean(orderBook
      && Date.now() - new Date(orderBook.updatedAt).getTime() <= MAX_MARKET_DATA_AGE_MS
      && orderBook.bids.length >= 20
      && orderBook.asks.length >= 20
      && Number.isFinite(orderBook.bestBid)
      && Number.isFinite(orderBook.bestAsk));
  }

  isCandleHistoryComplete(candles) {
    return candles.length >= REQUIRED_CANDLES
      && candles.every((candle) => candle.isClosed === true)
      && candles.slice(1).every((candle, index) =>
        candles[index].closeTime + 1 === candle.openTime);
  }

  allMarketDataReady() {
    if (!this.feed.connected) return false;
    return SYMBOLS.every((symbol) => {
      const state = this.feedStates.get(symbol);
      const candleDataReady = config.entryIntervals.every((interval) => {
        const candles = this.candleHistories.get(interval)?.get(symbol) || [];
        if (candles.length >= REQUIRED_CANDLES && !this.isCandleHistoryComplete(candles)) {
          this.candleErrors.get(interval).set(
            symbol,
            `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: ${interval} completed candle history contains a time gap`,
          );
        }
        return this.isCandleHistoryComplete(candles)
          && !this.candleErrors.get(interval)?.get(symbol);
      });
      return candleDataReady
        && this.isTradeQuoteFresh(symbol, this.prices.get(symbol), state?.lastTradeAt);
    });
  }

  getExit(trade, candle) {
    const hasTp1Price = Number.isFinite(trade.tp1Price);
    const target = trade.tp1Filled === true
      ? (trade.tp2Price ?? trade.takeProfit)
      : (hasTp1Price ? trade.tp1Price : trade.takeProfit);
    const targetReason = trade.tp1Filled === true || !hasTp1Price
      ? 'TAKE_PROFIT'
      : 'PARTIAL_TP1_FILLED';
    if (trade.side === 'LONG') {
      if (candle.low <= trade.stopLoss) {
        return { reason: 'STOP_LOSS' };
      }
      if (Number.isFinite(target) && candle.high >= target) {
        return { reason: targetReason };
      }
    } else {
      if (candle.high >= trade.stopLoss) {
        return { reason: 'STOP_LOSS' };
      }
      if (Number.isFinite(target) && candle.low <= target) {
        return { reason: targetReason };
      }
    }
    return null;
  }

  async getManagedExit(trade, candle) {
    const exitBeforeProtection = this.getExit(trade, candle);
    if (exitBeforeProtection?.reason === 'STOP_LOSS'
      || exitBeforeProtection?.reason === 'PARTIAL_TP1_FILLED') return exitBeforeProtection;

    const protectedTrade = await this.updateTradeProtection(trade, candle);
    return protectedTrade ? this.getExit(protectedTrade, candle) : null;
  }

  async updateTradeProtection(trade, candle) {
    const entryPrice = Number(trade.entryPrice);
    const initialStopLoss = Number(trade.initialStopLoss ?? trade.stopLoss);
    const riskDistance = Math.abs(entryPrice - initialStopLoss);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(riskDistance) || riskDistance <= 0) {
      return trade;
    }

    const isLong = trade.side === 'LONG';
    const priorExtreme = Number(isLong
      ? trade.highestPrice ?? entryPrice
      : trade.lowestPrice ?? entryPrice);
    const candleExtreme = Number(isLong ? candle.high : candle.low);
    const extreme = isLong
      ? Math.max(priorExtreme, candleExtreme)
      : Math.min(priorExtreme, candleExtreme);
    const favorableR = isLong
      ? (extreme - entryPrice) / riskDistance
      : (entryPrice - extreme) / riskDistance;
    let stopLoss = Number(trade.stopLoss);

    if (favorableR >= 1) {
      const feeAdjustedBreakeven = entryPrice * (isLong ? 1.0035 : 0.9965);
      stopLoss = isLong
        ? Math.max(stopLoss, feeAdjustedBreakeven)
        : Math.min(stopLoss, feeAdjustedBreakeven);
    }

    stopLoss = round(stopLoss, 8);
    const extremeField = isLong ? 'highestPrice' : 'lowestPrice';
    const extremeChanged = extreme !== priorExtreme;
    const stopChanged = stopLoss !== Number(trade.stopLoss);
    if (!extremeChanged && !stopChanged) return trade;

    const monotonicUpdate = isLong
      ? { $max: { highestPrice: extreme, stopLoss } }
      : { $min: { lowestPrice: extreme, stopLoss } };
    const updatedTrade = await PaperTrade.findOneAndUpdate(
      { _id: trade._id, status: 'OPEN' },
      monotonicUpdate,
      { returnDocument: 'after' },
    );
    if (!updatedTrade) return null;

    trade[extremeField] = Number(updatedTrade[extremeField]);
    trade.stopLoss = Number(updatedTrade.stopLoss);
    return trade;
  }

  async closeAtMarket(trade, reason) {
    const tradeId = trade._id.toString();
    if (this.closingTrades.has(tradeId)) return null;
    this.closingTrades.add(tradeId);
    try {
      if (!this.feed.connected) return null;
      const quote = this.prices.get(trade.symbol);
      const lastTradeAt = this.feedStates.get(trade.symbol)?.lastTradeAt;
      if (!this.isTradeQuoteFresh(trade.symbol, quote, lastTradeAt)) return null;
      const exitPrice = round(quote, 12);
      const failureAnalysis = reason === 'STOP_LOSS'
        ? this.captureFailureAnalysis(trade.symbol)
        : null;
      return await this.closeTrade(trade._id, exitPrice, reason, quote, failureAnalysis);
    } finally {
      this.closingTrades.delete(tradeId);
    }
  }

  captureFailureAnalysis(symbol) {
    const capturedAt = new Date();
    try {
      const analysis = analyzeCandles(this.candles.get(symbol) || []);
      return {
        capturedAt,
        bullishCount: analysis.bullishCount,
        bearishCount: analysis.bearishCount,
        totalVotes: analysis.totalVotes,
        currentVolume: analysis.currentVolume,
        averageVolume: analysis.averageVolume,
        volumeRatio: analysis.volumeRatio,
        indicators: analysis.indicators,
      };
    } catch (error) {
      this.logger.error('Unable to capture stop-loss indicator feedback', { symbol, error });
      return {
        capturedAt,
        analysisError: error.message,
        volumeRatio: null,
        indicators: [],
      };
    }
  }

  async dailyCircuitBreakerReached(now = new Date()) {
    const state = await this.initializeDailyRiskState(now);
    const equityLossLimit = Number(state.dayStartEquity) * DAILY_LOSS_EQUITY_FRACTION;
    const lossTriggered = Number(state.dailyNetRealizedPnl) <= -equityLossLimit;
    const streakTriggered = Number(state.consecutiveLosses) >= DAILY_CONSECUTIVE_LOSS_LIMIT;
    const shouldPause = Boolean(state.paused || lossTriggered || streakTriggered);
    if (!shouldPause) return false;

    const reason = state.pauseReason
      || (streakTriggered ? 'CONSECUTIVE_LOSSES' : 'DAILY_EQUITY_LOSS');
    await DailyRiskState.updateOne(
      { _id: state._id },
      { $set: { paused: true, pauseReason: reason, pausedAt: state.pausedAt || now } },
    );
    this.recordDailyCircuitBreaker(reason, state, equityLossLimit, now);
    return true;
  }

  recordDailyCircuitBreaker(reason, state, equityLossLimit, now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    if (this.dailyLossAlertDate === today) return;
    this.dailyLossAlertDate = today;
    const message = reason === 'CONSECUTIVE_LOSSES'
      ? `New entries paused after ${DAILY_CONSECUTIVE_LOSS_LIMIT} consecutive losing trades today (UTC)`
      : `New entries paused after daily net realized loss reached 5% of UTC day-start equity (${equityLossLimit.toFixed(2)} USDT)`;
    this.logger.warn(message);
    this.recordAudit('ENGINE', null, message);
    this.dispatchNotification('daily loss circuit breaker', () =>
      notifyDailyLossLimit(equityLossLimit, this.logger));
  }

  dispatchNotification(event, send) {
    void Promise.resolve()
      .then(send)
      .catch((error) => {
        this.logger.warn('Paper trading notification failed', { event, error });
      });
  }

  calculateTradeResult(
    trade,
    exitPrice,
    quantity = trade.quantity,
    entryFeeUsd = 0
  ) {
    const sign = trade.side === 'LONG' ? 1 : -1;
    const grossPnlUsd = round(sign * (exitPrice - trade.entryPrice) * quantity, 8);
    const allocatedEntryFeeUsd = 0;
    const exitFeeUsd = 0;
    const totalFeesUsd = 0;
    return {
      grossPnlUsd,
      entryFeeUsd: allocatedEntryFeeUsd,
      exitFeeUsd,
      totalFeesUsd,
      netPnlUsd: grossPnlUsd,
    };
  }

  getCooldownUntil(closedAt = new Date()) {
    return new Date(closedAt.getTime()
      + CANDLE_INTERVAL_MS[config.candleInterval] * COOLDOWN_CANDLES);
  }

  async openTrade(tradeData) {
    const htfContext = getHtfEntryContext(
      tradeData.side,
      tradeData.htf1hTrend,
      tradeData.htf4hTrend,
    );
    const isAPlus = htfContext.htfAlignment === 'ALIGNED_1H_4H';
    const maxPositionMargin = isAPlus
      ? A_PLUS_MAX_POSITION_MARGIN_USDT
      : MAX_POSITION_MARGIN_USDT;
    if (!Number.isFinite(tradeData.margin)
      || tradeData.margin <= 0
      || tradeData.margin > maxPositionMargin
      || htfContext.counterTrendBlocked
      || tradeData.htfAlignment !== htfContext.htfAlignment
      || tradeData.allocationPercent !== htfContext.allocationPercent) return null;
    const session = await mongoose.startSession();
    try {
      let createdTrade;
      await session.withTransaction(async () => {
        const existingTrade = await PaperTrade.findOne({
          symbol: tradeData.symbol,
          status: 'OPEN',
        }).session(session);
        if (existingTrade) return;
        const openTradeCount = await PaperTrade.countDocuments({ status: 'OPEN' }).session(session);
        if (openTradeCount >= config.maxOpenTrades) return;
        const wallet = await VirtualWallet.findOneAndUpdate(
          {
            _id: 'primary',
            availableMargin: {
              $gte: Math.max(
                tradeData.margin,
                tradeData.margin / (tradeData.allocationPercent / 100),
              ),
            },
          },
          {
            $inc: {
              availableMargin: -tradeData.margin,
              inTradeMargin: tradeData.margin,
            },
          },
          { returnDocument: 'after', session }
        );
        if (!wallet) return;
        const [trade] = await PaperTrade.create([tradeData], { session });
        createdTrade = trade;
      });
      if (createdTrade) {
        this.logger.info('Paper position opened', {
          tradeId: createdTrade.id,
          symbol: tradeData.symbol,
          side: tradeData.side,
          quantity: tradeData.quantity,
          entryFeeUsd: tradeData.entryFeeUsd,
          htf1hTrend: tradeData.htf1hTrend,
          htf4hTrend: tradeData.htf4hTrend,
          htfAlignment: tradeData.htfAlignment,
          allocationPercent: tradeData.allocationPercent,
        });
        this.recordAudit(
          'TRADE',
          tradeData.symbol,
          `Opened ${tradeData.side} paper position · HTF 1H ${tradeData.htf1hTrend} / 4H ${tradeData.htf4hTrend} · ${tradeData.htfAlignment} · ${tradeData.allocationPercent}% allocation`,
        );
        this.dispatchNotification('trade opened', () =>
          notifyTradeOpened(createdTrade, this.logger));
      }
      return createdTrade || null;
    } catch (error) {
      if (error.code !== 11000) throw error;
      this.logger.warn('A paper position for this symbol was opened concurrently; entry skipped', {
        symbol: tradeData.symbol,
      });
      this.recordAudit('TRADE', tradeData.symbol, 'Entry skipped: this symbol already has an open paper position');
      return null;
    } finally {
      await session.endSession();
    }
  }

  async closeTrade(
    tradeId,
    exitPrice,
    closeReason = 'MANUAL',
    exitQuote = exitPrice,
    failureAnalysis = null
  ) {
    if (!Number.isFinite(exitPrice) || exitPrice <= 0 || !Number.isFinite(exitQuote) || exitQuote <= 0) {
      throw new Error('Exit price must be positive and based on a real quote');
    }
    const session = await mongoose.startSession();
    try {
      let closedTrade;
      let updatedWallet;
      await session.withTransaction(async () => {
        const trade = await PaperTrade.findOne({ _id: tradeId, status: 'OPEN' }).session(session);
        if (!trade) return;
        const isPartialTp1 = closeReason === 'PARTIAL_TP1_FILLED';
        if (isPartialTp1 && trade.tp1Filled === true) return;
        const initialQuantity = Number(trade.initialQuantity || trade.quantity);
        const remainingQuantity = Number(trade.remainingQuantity ?? trade.quantity);
        const exitQuantity = isPartialTp1
          ? round(initialQuantity * 0.5, 8)
          : remainingQuantity;
        if (!Number.isFinite(exitQuantity) || exitQuantity <= 0 || exitQuantity > remainingQuantity) {
          throw new Error(`Invalid exit quantity for trade ${trade.id}`);
        }

        const priorRealizedPnl = Number(trade.realizedPnl || 0);
        const priorGrossPnlUsd = Number(trade.grossPnlUsd || 0);
        const priorExitFeeUsd = Number(trade.exitFeeUsd || 0);
        const result = this.calculateTradeResult(trade, exitPrice, exitQuantity);
        const { grossPnlUsd, exitFeeUsd, totalFeesUsd, netPnlUsd } = result;
        const cumulativeRealizedPnl = round(priorRealizedPnl + netPnlUsd, 8);
        const cumulativeGrossPnlUsd = round(priorGrossPnlUsd + grossPnlUsd, 8);
        const cumulativeExitFeeUsd = round(priorExitFeeUsd + exitFeeUsd, 8);
        const cumulativeFeesUsd = round(Number(trade.entryFeeUsd || 0) + cumulativeExitFeeUsd, 8);
        const pnlPercent = round((cumulativeRealizedPnl / trade.margin) * 100, 2);
        const exitCost = Math.abs(exitPrice - exitQuote) * exitQuantity;
        const isStopLoss = closeReason === 'STOP_LOSS' && cumulativeRealizedPnl < 0;
        const closedAt = new Date();
        const cooldownUntil = isStopLoss ? this.getCooldownUntil(closedAt) : null;
        const newRemainingQuantity = isPartialTp1
          ? round(remainingQuantity - exitQuantity, 8)
          : 0;
        const feeAdjustedBreakeven = Number(trade.entryPrice)
          * (trade.side === 'LONG' ? 1.0035 : 0.9965);
        const partialStopLoss = round(feeAdjustedBreakeven, 8);
        const releaseMargin = round(trade.margin * exitQuantity / initialQuantity, 8);
        const tradeFields = {
          exitPrice,
          exitQuote,
          executionCostUsd: round(Number(trade.executionCostUsd || 0) + exitCost, 8),
          exitFeeUsd: cumulativeExitFeeUsd,
          totalFeesUsd: cumulativeFeesUsd,
          grossPnlUsd: cumulativeGrossPnlUsd,
          pnlUsd: cumulativeRealizedPnl,
          pnlPercent,
          realizedPnl: cumulativeRealizedPnl,
        };
        if (isPartialTp1) {
          Object.assign(tradeFields, {
            tp1Filled: true,
            remainingQuantity: newRemainingQuantity,
            stopLoss: partialStopLoss,
          });
        } else {
          Object.assign(tradeFields, {
            status: 'CLOSED',
            remainingQuantity: 0,
            closeReason,
            closedAt,
            failureAnalysis: isStopLoss ? failureAnalysis : null,
            cooldownUntil,
          });
        }

        const tradeUpdate = await PaperTrade.updateOne(
          {
            _id: trade._id,
            status: 'OPEN',
            ...(isPartialTp1 ? { tp1Filled: { $ne: true } } : {}),
          },
          { $set: tradeFields },
          { session }
        );
        if (tradeUpdate.matchedCount !== 1) {
          if (isPartialTp1) return;
          throw new Error(`Trade ${trade.id} was concurrently closed`);
        }
        updatedWallet = await VirtualWallet.findOneAndUpdate(
          { _id: 'primary', inTradeMargin: { $gte: releaseMargin } },
          {
            $inc: {
              balance: netPnlUsd,
              availableMargin: releaseMargin + grossPnlUsd - exitFeeUsd,
              inTradeMargin: -releaseMargin,
              totalRealizedPnl: netPnlUsd,
              winCount: !isPartialTp1 && cumulativeRealizedPnl > 0 ? 1 : 0,
              lossCount: !isPartialTp1 && cumulativeRealizedPnl <= 0 ? 1 : 0,
            },
          },
          { returnDocument: 'after', session }
        );
        if (!updatedWallet) throw new Error('Wallet margin does not cover the open trade');
        const dayKey = closedAt.toISOString().slice(0, 10);
        const dailyRiskState = await DailyRiskState.findById(dayKey).session(session);
        const priorDailyNet = Number(dailyRiskState?.dailyNetRealizedPnl || 0);
        const dailyNetRealizedPnl = round(priorDailyNet + netPnlUsd, 8);
        const dayStartEquity = Number(dailyRiskState?.dayStartEquity
          ?? Math.max(0, Number(updatedWallet.balance) - dailyNetRealizedPnl));
        const consecutiveLosses = isPartialTp1
          ? Number(dailyRiskState?.consecutiveLosses || 0)
          : cumulativeRealizedPnl < 0
            ? Number(dailyRiskState?.consecutiveLosses || 0) + 1
            : 0;
        const pauseReason = dailyRiskState?.pauseReason
          || (consecutiveLosses >= DAILY_CONSECUTIVE_LOSS_LIMIT
            ? 'CONSECUTIVE_LOSSES'
            : dailyNetRealizedPnl <= -(dayStartEquity * DAILY_LOSS_EQUITY_FRACTION)
              ? 'DAILY_EQUITY_LOSS'
              : null);
        await DailyRiskState.findOneAndUpdate(
          { _id: dayKey },
          {
            $setOnInsert: { dayStartEquity },
            $set: {
              dailyNetRealizedPnl,
              consecutiveLosses,
              paused: Boolean(dailyRiskState?.paused || pauseReason),
              pauseReason,
              ...(pauseReason && !dailyRiskState?.pausedAt ? { pausedAt: closedAt } : {}),
            },
          },
          { upsert: true, returnDocument: 'after', session },
        );
        closedTrade = {
          id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          htf1hTrend: trade.htf1hTrend || 'NEUTRAL',
          htf4hTrend: trade.htf4hTrend || 'NEUTRAL',
          htfAlignment: trade.htfAlignment || 'STANDARD',
          allocationPercent: trade.allocationPercent || STANDARD_ALLOCATION_PERCENT,
          exitPrice,
          pnlUsd: cumulativeRealizedPnl,
          cumulativePnlUsd: cumulativeRealizedPnl,
          pnlPercent,
          grossPnlUsd: cumulativeGrossPnlUsd,
          realizedPnlUsd: netPnlUsd,
          feesDeductedUsd: totalFeesUsd,
          totalFeesUsd: cumulativeFeesUsd,
          closeReason,
          isPartialTp1,
          stopLoss: isPartialTp1 ? partialStopLoss : trade.stopLoss,
          cooldownUntil,
          walletBalance: updatedWallet.balance,
        };
      });
      if (closedTrade && closedTrade.isPartialTp1) {
        this.logger.info('Paper position partially closed at TP1', closedTrade);
        this.recordAudit(
          'TRADE',
          closedTrade.symbol,
          `PARTIAL_TP1_FILLED; HTF 1H ${closedTrade.htf1hTrend} / 4H ${closedTrade.htf4hTrend}; ${closedTrade.htfAlignment}; ${closedTrade.allocationPercent}% allocation; realized P&L ${closedTrade.realizedPnlUsd.toFixed(8)} USDT; fees deducted ${closedTrade.feesDeductedUsd.toFixed(8)} USDT; new stop-loss ${closedTrade.stopLoss}`,
        );
      }
      if (closedTrade && !closedTrade.isPartialTp1) this.logger.info('Paper position closed', closedTrade);
      if (closedTrade && !closedTrade.isPartialTp1) {
        this.dispatchNotification('trade closed', () =>
          notifyTradeClosed(closedTrade, this.logger));
        const cooldownMessage = closedTrade.cooldownUntil
          ? `; symbol cooldown until ${closedTrade.cooldownUntil.toISOString()}`
          : '';
        this.recordAudit(
          'TRADE',
          closedTrade.symbol,
          `Closed paper position: ${closeReason}; HTF 1H ${closedTrade.htf1hTrend} / 4H ${closedTrade.htf4hTrend}; ${closedTrade.htfAlignment}; ${closedTrade.allocationPercent}% allocation; net P&L ${closedTrade.pnlUsd.toFixed(2)} USDT${cooldownMessage}`
        );
      }
      return closedTrade || null;
    } finally {
      await session.endSession();
    }
  }

  async status() {
    const state = await BotState.findById('primary').lean();
    const dailyRiskState = await this.initializeDailyRiskState();
    const dailyLossLimit = Number(dailyRiskState.dayStartEquity) * DAILY_LOSS_EQUITY_FRACTION;
    return {
      running: this.running,
      enabled: this.enabled && Boolean(state?.enabled),
      feedConnected: this.feed.connected,
      interval: config.candleInterval,
      entryIntervals: config.entryIntervals,
      symbols: SYMBOLS,
      prices: Object.fromEntries(this.prices),
      riskPercent: 0,
      positionMarginFraction: POSITION_MARGIN_FRACTION,
      maxPositionMargin: MAX_POSITION_MARGIN_USDT,
      aPlusPositionMarginFraction: A_PLUS_POSITION_MARGIN_FRACTION,
      aPlusMaxPositionMargin: A_PLUS_MAX_POSITION_MARGIN_USDT,
      takerFeeRate: TAKER_FEE_RATE,
      rewardRiskRatio: 2,
      leverage: config.leverage,
      dailyLossLimit,
      dailyLossEquityFraction: DAILY_LOSS_EQUITY_FRACTION,
      dailyConsecutiveLossLimit: DAILY_CONSECUTIVE_LOSS_LIMIT,
      dailyCircuitBreaker: {
        dayStartEquity: dailyRiskState.dayStartEquity,
        dailyNetRealizedPnl: dailyRiskState.dailyNetRealizedPnl,
        consecutiveLosses: dailyRiskState.consecutiveLosses,
        paused: dailyRiskState.paused,
        pauseReason: dailyRiskState.pauseReason,
        pausedUntil: new Date(`${dailyRiskState._id}T23:59:59.999Z`).toISOString(),
      },
      tickCounts: Object.fromEntries(this.tickCounts),
      lastProcessed: Object.fromEntries(this.lastProcessedCandle),
      marketDataReady: this.allMarketDataReady(),
      marketErrors: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, {
        ...this.feedStates.get(symbol),
        intervalErrors: Object.fromEntries(config.entryIntervals.map((interval) => [
          interval,
          this.candleErrors.get(interval)?.get(symbol) || null,
        ])),
      }])),
    };
  }

  getAuditLog() {
    return this.auditLog;
  }

  getMarketSnapshot(symbol) {
    if (!SYMBOLS.includes(symbol)) {
      const error = new Error(`Unsupported symbol: ${symbol}`);
      error.status = 400;
      throw error;
    }
    const history = this.candleHistories.get(config.candleInterval)?.get(symbol) || [];
    const candles = history.slice(-REQUIRED_CANDLES);
    const orderBook = this.orderBooks.get(symbol);
    const state = this.feedStates.get(symbol);
    const lastTradeAt = state?.lastTradeAt;
    const lastTradeAge = lastTradeAt ? Date.now() - new Date(lastTradeAt).getTime() : Infinity;
    const orderBookFresh = this.isOrderBookFresh(orderBook);
    const tradePriceFresh = this.isTradeQuoteFresh(symbol, this.prices.get(symbol), lastTradeAt);
    const priceSource = tradePriceFresh
      ? 'TRADE'
      : orderBookFresh ? 'ORDER_BOOK_MID' : null;
    const quoteUpdatedAt = priceSource === 'TRADE' ? lastTradeAt : orderBook?.updatedAt;
    const marketAge = quoteUpdatedAt ? Date.now() - new Date(quoteUpdatedAt).getTime() : Infinity;
    const intervalError = config.entryIntervals
      .map((interval) => this.candleErrors.get(interval)?.get(symbol))
      .find(Boolean);
    const candleError = intervalError
      || state?.error
      || (history.length < REQUIRED_CANDLES
        ? `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: expected at least ${REQUIRED_CANDLES} completed candles, received ${history.length}`
        : !this.isCandleHistoryComplete(history)
          ? `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: completed candle history is invalid or contains a time gap`
          : null);
    const orderBookError = state?.orderBookError
      || (!orderBookFresh ? 'ORDERBOOK_DISCONNECTED' : null);
    const candleIntervalMs = CANDLE_INTERVAL_MS[config.candleInterval];
    const lastClosedAt = candles.length
      ? candles[candles.length - 1].openTime + candleIntervalMs
      : null;
    const nextCandleCloseAt = lastClosedAt && lastClosedAt > Date.now()
      ? lastClosedAt
      : lastClosedAt ? lastClosedAt + candleIntervalMs : null;
    return {
      symbol,
      candles,
      orderBook,
      price: priceSource === 'TRADE'
        ? this.prices.get(symbol) ?? null
        : orderBookFresh ? (orderBook.bestBid + orderBook.bestAsk) / 2 : this.prices.get(symbol) ?? null,
      priceSource,
      lastTradeAt: lastTradeAt ?? null,
      marketAgeMs: Number.isFinite(marketAge) ? marketAge : null,
      tickCount: this.tickCounts.get(symbol) || 0,
      nextCandleCloseAt: nextCandleCloseAt ? new Date(nextCandleCloseAt).toISOString() : null,
      candleError,
      ready: !candleError && tradePriceFresh && this.feed.connected,
      orderBookError,
    };
  }

  getIndicators(symbol) {
    const market = this.getMarketSnapshot(symbol);
    if (market.candleError) {
      const error = new Error(market.candleError);
      error.status = 503;
      throw error;
    }
    if (market.candles.length < MIN_CANDLES) {
      const error = new Error('INSUFFICIENT_HISTORICAL_DATA');
      error.status = 503;
      throw error;
    }
    const analysis = analyzeCandles(
      this.candleHistories.get(config.candleInterval)?.get(symbol) || market.candles,
    );
    const book = market.orderBook;
    if (book && Number.isFinite(book.bidQuantity) && Number.isFinite(book.askQuantity)) {
      const totalQuantity = book.bidQuantity + book.askQuantity;
      if (totalQuantity > 0) {
        analysis.orderBookPressure = {
          bidQuantity: book.bidQuantity,
          askQuantity: book.askQuantity,
          bidPercent: (book.bidQuantity / totalQuantity) * 100,
          askPercent: (book.askQuantity / totalQuantity) * 100,
        };
      }
    }
    return analysis;
  }

  getAllMarketSnapshots({ allowUnavailable = false } = {}) {
    const markets = SYMBOLS.map((symbol) => this.getMarketSnapshot(symbol));
    const unavailable = markets.find((market) => !market.ready);
    if (unavailable && !allowUnavailable) {
      const error = new Error(unavailable.candleError || `DATA_FEED_OFFLINE: Binance real feed failed for ${unavailable.symbol}: live trade quote is stale`);
      error.status = 503;
      throw error;
    }
    const analyses = new Map(markets.map((market) => [
      market.symbol,
      market.candleError || (allowUnavailable && !market.ready)
        ? unavailableAnalysis()
        : this.getIndicators(market.symbol),
    ]));
    const topOpportunities = rankOpportunities(
      markets
        .filter((market) => market.ready)
        .map((market) => ({ symbol: market.symbol, analysis: analyses.get(market.symbol) }))
        .filter((entry) => entry.analysis.side),
    );
    const topRanks = new Map(topOpportunities.map((entry) => [entry.symbol, entry.opportunityRank]));
    return markets.map((market) => ({
      symbol: market.symbol,
      price: market.price,
      priceSource: market.priceSource,
      ready: market.ready,
      candleError: market.candleError,
      lastTradeAt: market.lastTradeAt,
      marketAgeMs: market.marketAgeMs,
      tickCount: market.tickCount,
      nextCandleCloseAt: market.nextCandleCloseAt,
      candleCount: market.candles.length,
      orderBook: market.orderBook ? {
        bids: market.orderBook.bids,
        asks: market.orderBook.asks,
        bestBid: market.orderBook.bestBid,
        bestAsk: market.orderBook.bestAsk,
        bidQuantity: market.orderBook.bidQuantity,
        askQuantity: market.orderBook.askQuantity,
        bidNotional: market.orderBook.bidNotional,
        askNotional: market.orderBook.askNotional,
        levelCount: market.orderBook.levelCount,
        updatedAt: market.orderBook.updatedAt,
      } : {
        bids: [],
        asks: [],
        bestBid: null,
        bestAsk: null,
        bidQuantity: 0,
        askQuantity: 0,
        bidNotional: 0,
        askNotional: 0,
        levelCount: 0,
        updatedAt: null,
      },
      indicators: {
        ...analyses.get(market.symbol),
        opportunityRank: topRanks.get(market.symbol) ?? null,
        isTopOpportunity: topRanks.has(market.symbol),
      },
    }));
  }
}

module.exports = PaperTradingEngine;
module.exports.SYMBOL_LOSING_STREAK_COOLDOWN = SYMBOL_LOSING_STREAK_COOLDOWN;
