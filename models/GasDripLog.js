const mongoose = require('mongoose');

/**
 * Audit log for every successful (and attempted) relayer gas drip.
 * Used for daily caps, abuse forensics, and wallet/user rate limits.
 */
const gasDripLogSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  walletAddress: {
    type: String,
    required: true,
    index: true,
  },
  playType: {
    type: String,
    enum: ['free', 'boost', 'market'],
    required: true,
  },
  amountWei: { type: String, required: true },
  amountEth: { type: Number },
  amountUsdApprox: { type: Number, default: 0 },
  txHash: { type: String },
  status: {
    type: String,
    enum: ['sent', 'failed', 'rejected'],
    default: 'sent',
    index: true,
  },
  reason: { type: String },
  ip: { type: String },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

gasDripLogSchema.index({ user: 1, createdAt: -1 });
gasDripLogSchema.index({ walletAddress: 1, createdAt: -1 });

module.exports = mongoose.model('GasDripLog', gasDripLogSchema);
