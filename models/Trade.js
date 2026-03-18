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
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Trade', tradeSchema);
