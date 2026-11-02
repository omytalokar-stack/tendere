const mongoose = require('mongoose');
const createApp = require('./app');
const { config } = require('./config');
const BotState = require('./models/BotState');
const PaperTrade = require('./models/PaperTrade');
const VirtualWallet = require('./models/VirtualWallet');
const PaperTradingEngine = require('./services/paperTradingEngine');

async function main() {
  if (!config.mongoUri) throw new Error('MONGODB_URI must be configured');
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 10,
  });
  await Promise.all([BotState.init(), PaperTrade.init(), VirtualWallet.init()]);
  console.info('Connected to MongoDB');

  const engine = new PaperTradingEngine();
  await engine.initializeWallet();
  const state = await engine.getOrCreateBotState();
  await engine.start({ enabled: state.enabled });

  const app = createApp(engine);
  const server = app.listen(config.port, () => {
    console.info(`Paper trading API listening on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}; shutting down`);
    engine.shutdown();
    server.close(async (error) => {
      if (error) console.error('HTTP server shutdown failed', error);
      try {
        await mongoose.disconnect();
        process.exit(error ? 1 : 0);
      } catch (disconnectError) {
        console.error('MongoDB shutdown failed', disconnectError);
        process.exit(1);
      }
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(async (error) => {
  console.error('Backend startup failed', error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
