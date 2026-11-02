const mongoose = require('mongoose');
const { config } = require('../config');

const virtualWalletSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'primary' },
    balance: { type: Number, required: true, min: 0, default: config.initialBalance },
    availableMargin: { type: Number, required: true, min: 0, default: config.initialBalance },
    inTradeMargin: { type: Number, required: true, min: 0, default: 0 },
    totalRealizedPnl: { type: Number, required: true, default: 0 },
    winCount: { type: Number, required: true, min: 0, default: 0 },
    lossCount: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('VirtualWallet', virtualWalletSchema);
