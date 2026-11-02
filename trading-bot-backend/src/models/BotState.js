const mongoose = require('mongoose');

const botStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'primary' },
    enabled: { type: Boolean, required: true },
    updatedBy: { type: String, default: 'system' },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('BotState', botStateSchema);
