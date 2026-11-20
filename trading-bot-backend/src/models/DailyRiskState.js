const mongoose = require('mongoose');

const dailyRiskStateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    dayStartEquity: { type: Number, required: true, min: 0 },
    dailyNetRealizedPnl: { type: Number, required: true, default: 0 },
    consecutiveLosses: { type: Number, required: true, min: 0, default: 0 },
    paused: { type: Boolean, required: true, default: false },
    pauseReason: { type: String, default: null },
    pausedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('DailyRiskState', dailyRiskStateSchema);
