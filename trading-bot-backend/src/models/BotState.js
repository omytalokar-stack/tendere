const mongoose = require('mongoose');
const { config } = require('../config');

const botStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'primary' },
    enabled: { type: Boolean, required: true, default: config.botEnabled },
    updatedBy: { type: String, default: 'system' },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('BotState', botStateSchema);
