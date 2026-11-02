const mongoose = require('mongoose');
const { config, SYMBOLS } = require('../config');
const BotState = require('../models/BotState');
const PaperTrade = require('../models/PaperTrade');
const VirtualWallet = require('../models/VirtualWallet');
const BinanceFeed = require('./binanceFeed');
const {
  analyzeCandles,
  getEntrySignal,
  RISK_PERCENT,
  sizePosition,
  MIN_CANDLES,
} = require('./strategy');
const { REQUIRED_CANDLES } = require('./binanceFeed');
const TAKER_SLIPPAGE_RATE = 0.00075;
const TAKER_FEE_RATE = 0.00075;
const COOLDOWN_CANDLES = 3;
const MAX_MARKET_DATA_AGE_MS = 15_000;
const CANDLE_INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

function round(value, places = 8) {
  return Number(value.toFixed(places));
}

class PaperTradingEngine {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.running = false;
    this.enabled = false;
    this.prices = new Map();
    this.candles = new Map(SYMBOLS.map((symbol) => [symbol, []]));
    this.lastProcessedCandle = new Map();
    this.lastEntryScanCandleOpenTime = 0;
    this.orderBooks = new Map();
    this.pendingExits = new Map();
    this.closingTrades = new Set();
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
        const state = this.feedStates.get(symbol);
        if (state) state.lastTradeAt = timestamp;
        this.handlePrice(symbol).catch((error) =>
          this.logger.error('Live tick processing failed', { symbol, error }));
      },
      onOrderBook: (symbol, orderBook) => this.orderBooks.set(symbol, orderBook),
      onFeedState: (symbol, update) => this.updateFeedState(symbol, update),
      logger,
    });
  }

  updateFeedState(symbol, update) {
    const previous = this.feedStates.get(symbol) || {};
    if (update.error && update.error !== previous.error) {
      this.recordAudit('FEED', symbol, update.error);
    }
    if (update.orderBookError && update.orderBookError !== previous.orderBookError) {
      this.recordAudit('FEED', symbol, update.orderBookError);
    }
    this.feedStates.set(symbol, { ...previous, ...update, updatedAt: new Date() });
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
      await this.feed.start();
    } catch (error) {
      this.running = false;
      this.feed.stop();
      throw error;
    }
    this.logger.info('Paper trading engine started', {
      symbols: SYMBOLS,
      interval: config.candleInterval,
      riskPercent: RISK_PERCENT,
      rewardRiskRatio: config.rewardRiskRatio,
      leverage: config.leverage,
      dailyLossLimit: config.dailyLossLimit,
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

  async handleCandles(symbol, incomingCandles, { historical, final = true, triggerOnly = false }) {
    const history = this.candles.get(symbol);
    if (!history) return;

    for (const candle of incomingCandles) {
      if (candle.isFinal !== true && !triggerOnly) continue;
      if (historical) {
        const existingIndex = history.findIndex((item) => item.openTime === candle.openTime);
        if (existingIndex >= 0) history[existingIndex] = candle;
        else history.push(candle);
        history.sort((a, b) => a.openTime - b.openTime);
        if (history.length > REQUIRED_CANDLES) history.splice(0, history.length - REQUIRED_CANDLES);
        this.lastProcessedCandle.set(symbol, Math.max(this.lastProcessedCandle.get(symbol) || 0, candle.openTime));
        continue;
      }

      const openTrade = await PaperTrade.findOne({ symbol, status: 'OPEN' });
      if (openTrade && candle.isFinal !== true) {
        const exit = this.getExit(openTrade, candle);
        if (exit) {
          this.pendingExits.set(symbol, exit.reason);
          const closed = await this.closeAtMarket(openTrade, exit.reason);
          if (closed) this.pendingExits.delete(symbol);
        }
        continue;
      }
      if (!final && !triggerOnly) continue;
      const priorTimestamp = this.lastProcessedCandle.get(symbol) || 0;
      const existingIndex = history.findIndex((item) => item.openTime === candle.openTime);
      if (candle.isFinal === true) {
        if (existingIndex >= 0) history[existingIndex] = candle;
        else history.push(candle);
      }
      history.sort((a, b) => a.openTime - b.openTime);
      if (history.length > REQUIRED_CANDLES) history.splice(0, history.length - REQUIRED_CANDLES);

      if (candle.isFinal !== true) continue;
      if (candle.openTime <= priorTimestamp) continue;

      if (!this.running) continue;
      await this.processClosedCandle(symbol, candle, history);
      this.lastProcessedCandle.set(symbol, candle.openTime);
    }

    if (historical) {
      const openTrade = await PaperTrade.findOne({ symbol, status: 'OPEN' });
      const historicalExit = openTrade && history
        .filter((candle) => new Date(candle.time).getTime() > new Date(openTrade.openedAt).getTime())
        .map((candle) => this.getExit(openTrade, candle))
        .find(Boolean);
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

  async processClosedCandle(symbol, candle, history) {
    const openTrade = await PaperTrade.findOne({ symbol, status: 'OPEN' });
    if (openTrade) {
      const exit = this.getExit(openTrade, candle)
        || await this.getMomentumReversal(openTrade, history);
      if (exit) {
        this.pendingExits.set(symbol, exit.reason);
        const closed = await this.closeAtMarket(openTrade, exit.reason);
        if (closed) this.pendingExits.delete(symbol);
      }
      return;
    }

    if (!this.enabled) return;
    if (!this.allMarketDataReady()) return;
    await this.scanMarketsForEntry(candle.openTime);
  }

  async scanMarketsForEntry(candleOpenTime) {
    if (candleOpenTime <= this.lastEntryScanCandleOpenTime) return;
    const histories = new Map(SYMBOLS.map((symbol) => [symbol, this.candles.get(symbol) || []]));
    if (!SYMBOLS.every((symbol) => {
      const history = histories.get(symbol);
      return history.length === REQUIRED_CANDLES
        && history[history.length - 1].openTime === candleOpenTime
        && this.isCandleHistoryComplete(history);
    })) return;

    this.lastEntryScanCandleOpenTime = candleOpenTime;
    if (await PaperTrade.exists({ status: 'OPEN' })) return;
    if (await this.dailyLossLimitReached()) {
      this.logger.warn('Daily loss limit reached; new paper positions are paused');
      return;
    }

    const wallet = await VirtualWallet.findById('primary');
    if (!wallet) throw new Error('Virtual wallet has not been initialized');

    for (const symbol of SYMBOLS) {
      if (await this.isSymbolCoolingDown(symbol)) continue;
      const history = histories.get(symbol);
      const executionBook = await this.refreshExecutionBook(symbol);
      if (!this.isOrderBookFresh(executionBook)) return;

      const analysis = analyzeCandles(history, executionBook);
      const direction = getEntrySignal(analysis);
      if (!direction) continue;

      const stopDistance = analysis.atr * 1.5;
      if (!Number.isFinite(stopDistance) || stopDistance <= 0) continue;
      const rawEntryQuote = direction === 'LONG' ? executionBook.bestAsk : executionBook.bestBid;
      const entryPrice = this.applyTakerSlippage(rawEntryQuote, direction === 'LONG' ? 'BUY' : 'SELL');
      const stopLoss = direction === 'LONG'
        ? entryPrice - stopDistance
        : entryPrice + stopDistance;
      const takeProfit = direction === 'LONG'
        ? entryPrice + stopDistance * config.rewardRiskRatio
        : entryPrice - stopDistance * config.rewardRiskRatio;
      if (stopLoss <= 0 || takeProfit <= 0) continue;

      const position = sizePosition({
        balance: wallet.balance,
        entryPrice,
        stopLoss,
        leverage: config.leverage,
      });
      const entryFeeUsd = round(entryPrice * position.quantity * TAKER_FEE_RATE, 8);
      if (!this.enabled
        || position.margin + entryFeeUsd > wallet.availableMargin
        || position.quantity <= 0) continue;

      const trade = await this.openTrade({
        symbol,
        side: direction,
        entryPrice,
        entryQuote: rawEntryQuote,
        executionCostUsd: round(Math.abs(entryPrice - rawEntryQuote) * position.quantity, 8),
        entryFeeUsd,
        exitFeeUsd: 0,
        totalFeesUsd: entryFeeUsd,
        quantity: position.quantity,
        margin: position.margin,
        leverage: config.leverage,
        stopLoss,
        takeProfit,
        strategy: `${analysis.strategy} (${direction === 'LONG' ? analysis.buyVotes : analysis.sellVotes}/${analysis.totalVotes})`,
        openedAt: new Date(),
      });
      if (trade) {
        return;
      }
    }
  }

  async isSymbolCoolingDown(symbol) {
    const coolingTrade = await PaperTrade.findOne({
      symbol,
      status: 'CLOSED',
      closeReason: 'STOP_LOSS',
      pnlUsd: { $lt: 0 },
      cooldownUntil: { $gt: new Date() },
    }).sort({ closedAt: -1 }).lean();
    return Boolean(coolingTrade);
  }

  async getMomentumReversal(trade, history) {
    let orderBook = this.orderBooks.get(trade.symbol);
    if (!this.isOrderBookFresh(orderBook)) {
      orderBook = await this.refreshExecutionBook(trade.symbol);
    }
    if (!this.isOrderBookFresh(orderBook)) return null;
    const direction = getEntrySignal(analyzeCandles(history, orderBook));
    return direction && direction !== trade.side
      ? { reason: 'EARLY_MOMENTUM_REVERSAL' }
      : null;
  }

  applyTakerSlippage(quote, action) {
    return round(quote * (action === 'BUY' ? 1 + TAKER_SLIPPAGE_RATE : 1 - TAKER_SLIPPAGE_RATE), 12);
  }

  async refreshExecutionBook(symbol) {
    const orderBook = this.orderBooks.get(symbol);
    if (this.isOrderBookFresh(orderBook)) return orderBook;
    this.updateFeedState(symbol, { orderBookError: 'ORDERBOOK_DISCONNECTED: no fresh Binance depth stream data' });
    this.logger.warn('Fresh Binance depth stream data unavailable; paper execution is frozen', { symbol });
    return null;
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
    return candles.length === REQUIRED_CANDLES
      && candles.every((candle) => candle.isFinal === true)
      && candles.slice(1).every((candle, index) =>
        candles[index].closeTime + 1 === candle.openTime);
  }

  allMarketDataReady() {
    if (!this.feed.connected) return false;
    return SYMBOLS.every((symbol) => {
      const candles = this.candles.get(symbol) || [];
      const state = this.feedStates.get(symbol);
      const orderBook = this.orderBooks.get(symbol);
      if (candles.length === REQUIRED_CANDLES && !this.isCandleHistoryComplete(candles)) {
        this.updateFeedState(symbol, {
          error: `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: completed candle history contains a time gap`,
        });
      }
      return this.isCandleHistoryComplete(candles)
        && !state?.error
        && !state?.orderBookError
        && this.isOrderBookFresh(orderBook);
    });
  }

  getExit(trade, candle) {
    if (trade.side === 'LONG') {
      if (candle.low <= trade.stopLoss) {
        return { reason: 'STOP_LOSS' };
      }
      if (candle.high >= trade.takeProfit) {
        return { reason: 'TAKE_PROFIT' };
      }
    } else {
      if (candle.high >= trade.stopLoss) {
        return { reason: 'STOP_LOSS' };
      }
      if (candle.low <= trade.takeProfit) {
        return { reason: 'TAKE_PROFIT' };
      }
    }
    return null;
  }

  async closeAtMarket(trade, reason) {
    const tradeId = trade._id.toString();
    if (this.closingTrades.has(tradeId)) return null;
    this.closingTrades.add(tradeId);
    try {
      if (!this.feed.connected) return null;
      const orderBook = await this.refreshExecutionBook(trade.symbol);
      if (!this.isOrderBookFresh(orderBook)) return null;
      const quote = trade.side === 'LONG' ? orderBook.bestBid : orderBook.bestAsk;
      const exitPrice = this.applyTakerSlippage(quote, trade.side === 'LONG' ? 'SELL' : 'BUY');
      const failureAnalysis = reason === 'STOP_LOSS'
        ? this.captureFailureAnalysis(trade.symbol, orderBook)
        : null;
      return await this.closeTrade(trade._id, exitPrice, reason, quote, failureAnalysis);
    } finally {
      this.closingTrades.delete(tradeId);
    }
  }

  captureFailureAnalysis(symbol, orderBook) {
    const capturedAt = new Date();
    try {
      const analysis = analyzeCandles(this.candles.get(symbol) || [], orderBook);
      return {
        capturedAt,
        buyVotes: analysis.buyVotes,
        sellVotes: analysis.sellVotes,
        totalVotes: analysis.totalVotes,
        currentVolume: analysis.currentVolume,
        averageVolume: analysis.averageVolume,
        volumeRatio: analysis.volumeRatio,
        orderBookPressure: analysis.orderBookPressure,
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

  async dailyLossLimitReached() {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const result = await PaperTrade.aggregate([
      { $match: { status: 'CLOSED', closedAt: { $gte: since }, pnlUsd: { $lt: 0 } } },
      { $group: { _id: null, loss: { $sum: '$pnlUsd' } } },
    ]);
    return Math.abs(result[0]?.loss || 0) >= config.dailyLossLimit;
  }

  calculateTradeResult(trade, exitPrice) {
    const sign = trade.side === 'LONG' ? 1 : -1;
    const grossPnlUsd = round(sign * (exitPrice - trade.entryPrice) * trade.quantity, 8);
    const entryFeeUsd = Number(trade.entryFeeUsd || 0);
    const exitFeeUsd = round(exitPrice * trade.quantity * TAKER_FEE_RATE, 8);
    const totalFeesUsd = round(entryFeeUsd + exitFeeUsd, 8);
    return {
      grossPnlUsd,
      entryFeeUsd,
      exitFeeUsd,
      totalFeesUsd,
      netPnlUsd: round(grossPnlUsd - totalFeesUsd, 8),
    };
  }

  getCooldownUntil(closedAt = new Date()) {
    return new Date(closedAt.getTime()
      + CANDLE_INTERVAL_MS[config.candleInterval] * COOLDOWN_CANDLES);
  }

  async openTrade(tradeData) {
    const session = await mongoose.startSession();
    try {
      let createdTrade;
      await session.withTransaction(async () => {
        const existingTrade = await PaperTrade.findOne({ status: 'OPEN' }).session(session);
        if (existingTrade) return;
        const wallet = await VirtualWallet.findOneAndUpdate(
          {
            _id: 'primary',
            availableMargin: { $gte: tradeData.margin + tradeData.entryFeeUsd },
          },
          {
            $inc: {
              availableMargin: -(tradeData.margin + tradeData.entryFeeUsd),
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
        });
        this.recordAudit('TRADE', tradeData.symbol, `Opened ${tradeData.side} paper position`);
      }
      return createdTrade || null;
    } catch (error) {
      if (error.code !== 11000) throw error;
      this.logger.warn('Another paper position was opened concurrently; entry skipped', { symbol: tradeData.symbol });
      this.recordAudit('TRADE', tradeData.symbol, 'Entry skipped: account already has an open paper position');
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
        const result = this.calculateTradeResult(trade, exitPrice);
        const { grossPnlUsd, entryFeeUsd, exitFeeUsd, totalFeesUsd, netPnlUsd } = result;
        const pnlPercent = round((netPnlUsd / trade.margin) * 100, 2);
        const exitCost = Math.abs(exitPrice - exitQuote) * trade.quantity;
        const isStopLoss = closeReason === 'STOP_LOSS' && netPnlUsd < 0;
        const closedAt = new Date();
        const cooldownUntil = isStopLoss ? this.getCooldownUntil(closedAt) : null;

        const tradeUpdate = await PaperTrade.updateOne(
          { _id: trade._id, status: 'OPEN' },
          {
            $set: {
              status: 'CLOSED',
              exitPrice,
              exitQuote,
              executionCostUsd: round(Number(trade.executionCostUsd || 0) + exitCost, 8),
              entryFeeUsd,
              exitFeeUsd,
              totalFeesUsd,
              grossPnlUsd,
              pnlUsd: netPnlUsd,
              pnlPercent,
              closeReason,
              closedAt,
              failureAnalysis: isStopLoss ? failureAnalysis : null,
              cooldownUntil,
            },
          },
          { session }
        );
        if (tradeUpdate.matchedCount !== 1) throw new Error(`Trade ${trade.id} was concurrently closed`);
        updatedWallet = await VirtualWallet.findOneAndUpdate(
          { _id: 'primary', inTradeMargin: { $gte: trade.margin } },
          {
            $inc: {
              balance: netPnlUsd,
              availableMargin: trade.margin + grossPnlUsd - exitFeeUsd,
              inTradeMargin: -trade.margin,
              totalRealizedPnl: netPnlUsd,
              winCount: netPnlUsd > 0 ? 1 : 0,
              lossCount: netPnlUsd <= 0 ? 1 : 0,
            },
          },
          { returnDocument: 'after', session }
        );
        if (!updatedWallet) throw new Error('Wallet margin does not cover the open trade');
        closedTrade = {
          id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          exitPrice,
          pnlUsd: netPnlUsd,
          pnlPercent,
          grossPnlUsd,
          totalFeesUsd,
          closeReason,
          cooldownUntil,
          walletBalance: updatedWallet.balance,
        };
      });
      if (closedTrade) this.logger.info('Paper position closed', closedTrade);
      if (closedTrade) {
        const cooldownMessage = closedTrade.cooldownUntil
          ? `; symbol cooldown until ${closedTrade.cooldownUntil.toISOString()}`
          : '';
        this.recordAudit(
          'TRADE',
          closedTrade.symbol,
          `Closed paper position: ${closeReason}; net P&L ${closedTrade.pnlUsd.toFixed(2)} USDT${cooldownMessage}`
        );
      }
      return closedTrade || null;
    } finally {
      await session.endSession();
    }
  }

  async status() {
    const state = await BotState.findById('primary').lean();
    return {
      running: this.running,
      enabled: this.enabled && Boolean(state?.enabled),
      feedConnected: this.feed.connected,
      interval: config.candleInterval,
      symbols: SYMBOLS,
      prices: Object.fromEntries(this.prices),
      riskPercent: RISK_PERCENT,
      takerFeeRate: TAKER_FEE_RATE,
      rewardRiskRatio: config.rewardRiskRatio,
      leverage: config.leverage,
      dailyLossLimit: config.dailyLossLimit,
      lastProcessed: Object.fromEntries(this.lastProcessedCandle),
      marketDataReady: this.allMarketDataReady(),
      marketErrors: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, this.feedStates.get(symbol)])),
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
    const candles = this.candles.get(symbol) || [];
    const orderBook = this.orderBooks.get(symbol);
    const state = this.feedStates.get(symbol);
    const lastTradeAt = state?.lastTradeAt;
    const lastTradeAge = lastTradeAt ? Date.now() - new Date(lastTradeAt).getTime() : Infinity;
    const orderBookFresh = this.isOrderBookFresh(orderBook);
    const priceSource = lastTradeAge <= MAX_MARKET_DATA_AGE_MS
      && Number.isFinite(this.prices.get(symbol))
      ? 'TRADE'
      : orderBookFresh ? 'ORDER_BOOK_MID' : null;
    const quoteUpdatedAt = priceSource === 'TRADE' ? lastTradeAt : orderBook?.updatedAt;
    const marketAge = quoteUpdatedAt ? Date.now() - new Date(quoteUpdatedAt).getTime() : Infinity;
    const candleError = state?.error
      || (candles.length !== REQUIRED_CANDLES
        ? `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: expected ${REQUIRED_CANDLES} completed candles, received ${candles.length}`
        : !this.isCandleHistoryComplete(candles)
          ? `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: completed candle history is invalid or contains a time gap`
          : null)
      || (!quoteUpdatedAt || marketAge > MAX_MARKET_DATA_AGE_MS
        ? `DATA_FEED_OFFLINE: Binance real feed failed for ${symbol}: no fresh trade or order-book quote`
        : null);
    const orderBookError = state?.orderBookError
      || (!orderBookFresh ? 'ORDERBOOK_DISCONNECTED' : null);
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
      candleError,
      orderBookError,
      ready: !candleError && !orderBookError && this.feed.connected,
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
    if (market.orderBookError || !market.orderBook) {
      const error = new Error('ORDERBOOK_DISCONNECTED');
      error.status = 503;
      throw error;
    }
    return analyzeCandles(market.candles, market.orderBook);
  }

  getAllMarketSnapshots() {
    const markets = SYMBOLS.map((symbol) => this.getMarketSnapshot(symbol));
    const unavailable = markets.find((market) => !market.ready);
    if (unavailable) {
      const error = new Error(unavailable.candleError || unavailable.orderBookError || `DATA_FEED_OFFLINE: Binance real feed failed for ${unavailable.symbol}`);
      error.status = 503;
      throw error;
    }
    return markets.map((market) => ({
      symbol: market.symbol,
      price: market.price,
      priceSource: market.priceSource,
      lastTradeAt: market.lastTradeAt,
      marketAgeMs: market.marketAgeMs,
      candleCount: market.candles.length,
      orderBook: {
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
      },
      indicators: this.getIndicators(market.symbol),
    }));
  }
}

module.exports = PaperTradingEngine;
