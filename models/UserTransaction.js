const mongoose = require('mongoose');

const userTransactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  action: {
    type: String,
    required: true,
    index: true,
  },
  txHash: {
    type: String,
    index: true,
  },
  amount: {
    type: Number,
  },
  currency: {
    type: String,
    enum: ['USDC', 'ETH'],
    default: 'USDC',
  },
  itemType: {
    type: String,
    enum: ['match', 'poll', 'none'],
    default: 'none',
  },
  itemId: {
    type: String,
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

module.exports = mongoose.model('UserTransaction', userTransactionSchema);

