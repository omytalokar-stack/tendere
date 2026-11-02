const mongoose = require('mongoose');

const paperTradeSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, enum: ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT'] },
    side: { type: String, required: true, enum: ['LONG', 'SHORT'] },
    status: { type: String, required: true, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    entryPrice: { type: Number, required: true, min: 0 },
    entryQuote: { type: Number, required: true, min: 0 },
    exitPrice: { type: Number, default: null },
    exitQuote: { type: Number, default: null },
    executionCostUsd: { type: Number, required: true, min: 0, default: 0 },
    entryFeeUsd: { type: Number, required: true, min: 0, default: 0 },
    exitFeeUsd: { type: Number, required: true, min: 0, default: 0 },
    totalFeesUsd: { type: Number, required: true, min: 0, default: 0 },
    quantity: { type: Number, required: true, min: 0 },
    margin: { type: Number, required: true, min: 0 },
    leverage: { type: Number, required: true, min: 1 },
    stopLoss: { type: Number, required: true, min: 0 },
    takeProfit: { type: Number, required: true, min: 0 },
    grossPnlUsd: { type: Number, default: 0 },
    pnlUsd: { type: Number, default: 0 },
    pnlPercent: { type: Number, default: 0 },
    closeReason: {
      type: String,
      enum: ['TAKE_PROFIT', 'STOP_LOSS', 'EARLY_MOMENTUM_REVERSAL', 'MANUAL'],
      default: null,
    },
    failureAnalysis: { type: mongoose.Schema.Types.Mixed, default: null },
    cooldownUntil: { type: Date, default: null },
    strategy: { type: String, required: true },
    openedAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

paperTradeSchema.index(
  { symbol: 1 },
  { unique: true, partialFilterExpression: { status: 'OPEN' } }
);
paperTradeSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: 'OPEN' }, name: 'one_open_paper_trade_per_account' }
);
paperTradeSchema.index({ status: 1, openedAt: -1 });
paperTradeSchema.index({ closedAt: -1 });

module.exports = mongoose.model('PaperTrade', paperTradeSchema);
