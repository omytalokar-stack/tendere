const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const BotState = require('./models/BotState');
const PaperTrade = require('./models/PaperTrade');
const VirtualWallet = require('./models/VirtualWallet');
const { config, SYMBOLS } = require('./config');
const controlAuth = require('./middleware/controlAuth');

function createApp(engine) {
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
  app.get('/api/market/status', (req, res, next) => {
    try {
      return res.json({
        interval: config.candleInterval,
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
    if ((error.status || error.statusCode || 500) >= 500) console.error('Request failed', error);
    if (res.headersSent) return next(error);
    const isExplicitDataError = /^(DATA_FEED_OFFLINE|INSUFFICIENT_HISTORICAL_DATA|ORDERBOOK_DISCONNECTED)/.test(error.message || '');
    const status = error.status
      || error.statusCode
      || (isExplicitDataError ? 503 : 500);
    const message = status >= 500 && !error.code && !isExplicitDataError ? 'Internal server error' : error.message;
    return res.status(status).json({ error: message });
  });

  return app;
}

module.exports = createApp;
