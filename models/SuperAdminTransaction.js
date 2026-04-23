const mongoose = require('mongoose');

const superAdminTransactionSchema = new mongoose.Schema({
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  action: {
    type: String,
    required: true,
    trim: true,
  },
  txHash: {
    type: String,
    trim: true,
  },
  chainId: {
    type: Number,
  },
  ethAmount: {
    type: Number,
  },
  usdAmount: {
    type: Number,
  },
  ethUsd: {
    type: Number,
  },
  meta: {
    type: Object,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

superAdminTransactionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SuperAdminTransaction', superAdminTransactionSchema);

