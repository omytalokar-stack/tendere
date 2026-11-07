const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const BotState = require('./models/BotState');
const PaperTrade = require('./models/PaperTrade');
const VirtualWallet = require('./models/VirtualWallet');
const { config, SYMBOLS } = require('./config');
const controlAuth = require('./middleware/controlAuth');
const agentReadAuth = require('./middleware/agentReadAuth');
const createAgentReadRateLimit = require('./middleware/agentReadRateLimit');
const { generateAssistantResponse } = require('./services/assistantProvider');

async function getAgentSnapshot(engine) {
  const [bot, wallet, trades] = await Promise.all([
    engine.status(),
    VirtualWallet.findById('primary').lean(),
    PaperTrade.find({})
      .select('_id symbol side status entryPrice exitPrice quantity initialQuantity remainingQuantity margin leverage stopLoss takeProfit tp1Price tp2Price tp1Filled realizedPnl pnlUsd pnlPercent closeReason openedAt closedAt')
      .sort({ openedAt: -1 })
      .limit(50)
      .lean(),
  ]);
  if (!wallet) return null;

  const markets = SYMBOLS.map((symbol) => {
    const market = engine.getMarketSnapshot(symbol);
    return {
      symbol,
      price: Number.isFinite(market.price) ? market.price : null,
      ready: Boolean(market.ready),
    };
  });
  const sanitizedWallet = {
    balance: wallet.balance,
    availableMargin: wallet.availableMargin,
    inTradeMargin: wallet.inTradeMargin,
    totalRealizedPnl: wallet.totalRealizedPnl,
    winCount: wallet.winCount,
    lossCount: wallet.lossCount,
  };
  const sanitizedTrades = trades.map((trade) => ({
    id: String(trade._id),
    symbol: trade.symbol,
    side: trade.side,
    status: trade.status,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    quantity: trade.quantity,
    initialQuantity: trade.initialQuantity,
    remainingQuantity: trade.remainingQuantity,
    margin: trade.margin,
    leverage: trade.leverage,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    tp1Price: trade.tp1Price,
    tp2Price: trade.tp2Price,
    tp1Filled: trade.tp1Filled,
    realizedPnl: trade.realizedPnl,
    pnlUsd: trade.pnlUsd,
    pnlPercent: trade.pnlPercent,
    closeReason: trade.closeReason,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
  }));
  const sanitizedBot = {
    running: Boolean(bot.running),
    enabled: Boolean(bot.enabled),
    feedConnected: Boolean(bot.feedConnected),
    marketDataReady: Boolean(bot.marketDataReady),
    interval: bot.interval,
    entryIntervals: bot.entryIntervals,
    symbols: SYMBOLS,
    prices: Object.fromEntries(markets.map((market) => [market.symbol, market.price])),
  };

  return {
    bot: sanitizedBot,
    wallet: sanitizedWallet,
    trades: sanitizedTrades,
    markets,
  };
}

function createApp(engine, { assistantGenerator = generateAssistantResponse } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const allowed = config.allowedOrigins.includes(origin)
        || /^https?:\/\/localhost(?::\d+)?$/.test(origin)
        || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
      if (allowed) return callback(null, true);
      const error = new Error('Origin is not allowed');
      error.status = 403;
      return callback(error);
    },
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large' });
    }
    if (error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, 'body')) {
      return res.status(400).json({ error: 'Invalid JSON request body' });
    }
    return next(error);
  });

  const agentReadRateLimit = createAgentReadRateLimit();

  app.get('/', (req, res) => res.json({
    status: 'ok',
    service: 'AuraAlgo Crypto Paper Trading',
  }));
  app.post('/assistant/query', agentReadAuth, agentReadRateLimit, async (req, res) => {
    const query = req.body?.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) {
      return res.status(400).json({ error: 'query must be a non-empty string of at most 1000 characters' });
    }
    if (!config.geminiApiKey) {
      return res.status(503).json({
        error: 'Gemini AI is not configured',
        code: 'AI_PROVIDER_NOT_CONFIGURED',
        missingConfiguration: 'GEMINI_API_KEY',
      });
    }
    const snapshot = await getAgentSnapshot(engine);
    if (!snapshot) return res.status(503).json({ error: 'Wallet is not initialized' });

    try {
      const response = await assistantGenerator(query.trim(), snapshot);
      if (typeof response !== 'string' || !response.trim()) {
        return res.status(502).json({ error: 'Assistant provider returned an invalid response' });
      }
      return res.json({ response: response.trim().slice(0, 2000) });
    } catch (error) {
      if (error?.code === 'AI_PROVIDER_NOT_CONFIGURED') {
        return res.status(503).json({
          error: 'Gemini AI is not configured',
          code: 'AI_PROVIDER_NOT_CONFIGURED',
          missingConfiguration: 'GEMINI_API_KEY',
        });
      }
      console.error('Assistant provider request failed');
      return res.status(502).json({ error: 'Assistant provider request failed' });
    }
  });
  app.get('/api/health/live', (req, res) => res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));
  app.get('/api/health/ready', (req, res) => {
    const databaseConnected = mongoose.connection.readyState === 1;
    res.status(databaseConnected ? 200 : 503).json({
      status: databaseConnected ? 'ready' : 'not_ready',
      database: databaseConnected ? 'connected' : 'disconnected',
      botRunning: engine.running,
    });
  });
  app.get('/api/bot/status', async (req, res) => res.json(await engine.status()));
  app.get('/api/bot/audit', (req, res) => res.json({ events: engine.getAuditLog() }));
  app.get('/api/agent/context', agentReadAuth, agentReadRateLimit, async (req, res) => {
    const snapshot = await getAgentSnapshot(engine);
    if (!snapshot) return res.status(503).json({ error: 'Wallet is not initialized' });
    return res.json({
      webappName: 'AuraAlgo Crypto Paper Trading',
      apiBasePath: '/api/agent/context',
      pollingIntervalSeconds: config.agentPollingIntervalSeconds,
      generatedAt: new Date().toISOString(),
      ...snapshot,
    });
  });
  app.get('/api/market/status', (req, res, next) => {
    try {
      return res.json({
        interval: config.candleInterval,
        entryIntervals: config.entryIntervals,
        markets: engine.getAllMarketSnapshots(),
      });
    } catch (error) {
      return next(error);
    }
  });
  app.get('/api/market/:symbol/candles', (req, res, next) => {
    try {
      const market = engine.getMarketSnapshot(req.params.symbol.toUpperCase());
      if (market.candleError) {
        const error = new Error(market.candleError);
        error.status = 503;
        throw error;
      }
      if (market.candles.length !== 500) {
        const error = new Error(`DATA_FEED_OFFLINE: Binance real feed failed for ${market.symbol}: expected 500 completed candles, received ${market.candles.length}`);
        error.status = 503;
        throw error;
      }
      return res.json({
        symbol: market.symbol,
        interval: config.candleInterval,
        count: market.candles.length,
        candles: market.candles,
      });
    } catch (error) {
      return next(error);
    }
  });
  app.get('/api/market/:symbol/indicators', (req, res, next) => {
    try {
      return res.json({
        symbol: req.params.symbol.toUpperCase(),
        indicators: engine.getIndicators(req.params.symbol.toUpperCase()),
      });
    } catch (error) {
      return next(error);
    }
  });
  app.get('/api/market/:symbol/orderbook', (req, res, next) => {
    try {
      const market = engine.getMarketSnapshot(req.params.symbol.toUpperCase());
      if (market.orderBookError || !market.orderBook) {
        const error = new Error('ORDERBOOK_DISCONNECTED');
        error.status = 503;
        throw error;
      }
      return res.json(market.orderBook);
    } catch (error) {
      return next(error);
    }
  });
  app.get('/api/wallet', async (req, res) => {
    const wallet = await VirtualWallet.findById('primary').lean();
    if (!wallet) return res.status(503).json({ error: 'Wallet is not initialized' });
    return res.json(wallet);
  });
  app.get('/api/trades', async (req, res) => {
    const { status } = req.query;
    if (status !== undefined && !['OPEN', 'CLOSED'].includes(status)) {
      return res.status(400).json({ error: 'status must be OPEN or CLOSED' });
    }
    const requestedLimit = Number(req.query.limit || 50);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
    }
    const query = status ? { status } : {};
    const trades = await PaperTrade.find(query).sort({ openedAt: -1 }).limit(requestedLimit).lean();
    return res.json({ trades });
  });
  app.get('/api/market/prices', (req, res, next) => {
    try {
      const markets = engine.getAllMarketSnapshots();
      return res.json({
        symbols: SYMBOLS,
        interval: config.candleInterval,
        prices: Object.fromEntries(markets.map((market) => [market.symbol, market.price])),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/bot/start', controlAuth, async (req, res) => {
    await engine.start();
    await BotState.findOneAndUpdate(
      { _id: 'primary' },
      { $set: { enabled: true, updatedBy: 'api' } },
      { upsert: true, returnDocument: 'after' }
    );
    return res.json({ running: engine.running, enabled: engine.enabled });
  });
  app.post('/api/bot/stop', controlAuth, async (req, res) => {
    engine.stop();
    await BotState.findOneAndUpdate(
      { _id: 'primary' },
      { $set: { enabled: false, updatedBy: 'api' } },
      { upsert: true, returnDocument: 'after' }
    );
    return res.json({ running: engine.running, enabled: engine.enabled });
  });
  app.post('/api/trades/:id/close', controlAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid trade id' });
    }
    const trade = await PaperTrade.findOne({ _id: req.params.id, status: 'OPEN' });
    if (!trade) return res.status(404).json({ error: 'Open trade not found' });
    const closed = await engine.closeAtMarket(trade, 'MANUAL');
    if (!closed) {
      const stillOpen = await PaperTrade.exists({ _id: trade._id, status: 'OPEN' });
      if (stillOpen) return res.status(503).json({ error: 'DATA_FEED_OFFLINE: fresh Binance bid/ask is required to close this position' });
      return res.status(409).json({ error: 'Trade was already closed' });
    }
    return res.json({ trade: closed });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const isExplicitDataError = /^(DATA_FEED_OFFLINE|INSUFFICIENT_HISTORICAL_DATA|ORDERBOOK_DISCONNECTED)/.test(error.message || '');
    const status = error.status
      || error.statusCode
      || (isExplicitDataError ? 503 : 500);
    if (status >= 500 && !isExplicitDataError) console.error('Request failed', error);
    const message = status >= 500 && !error.code && !isExplicitDataError ? 'Internal server error' : error.message;
    return res.status(status).json({ error: message });
  });

  return app;
}

module.exports = createApp;
