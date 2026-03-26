const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  match: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Match',
  },
  poll: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Poll',
  },
  type: {
    type: String,
    enum: ['buy', 'sell'],
    required: true,
  },
  outcome: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  shares: {
    type: Number,
    default: 0,
  },
  price: {
    type: Number,
    default: 0,
  },
  // Full post-trade price snapshot (e.g. { yes, no } or { teamA, draw, teamB } or option-text keys).
  // Used for accurate charting since every trade changes all outcome prices.
  pricesSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Trade', tradeSchema);
