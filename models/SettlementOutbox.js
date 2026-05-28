const mongoose = require('mongoose');

const legSchema = new mongoose.Schema(
  {
    user: { type: String, required: true },
    positionKey: { type: String, required: true },
    vaultDelta: { type: String, required: true },
    sharesDelta: { type: String, required: true },
    investedDelta: { type: String, required: true },
  },
  { _id: false }
);

const settlementOutboxSchema = new mongoose.Schema({
  contractAddress: { type: String, lowercase: true, trim: true },
  chainMarketId: { type: Number, required: true },
  legs: { type: [legSchema], required: true },
  feeToClaimPool: { type: String, required: true },
  /** Free-jackpot fee share (USDC wei string); remainder is `feeToClaimPool` (platform / claim pool). */
  feeToJackpotPool: { type: String, default: '0' },
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  status: {
    type: String,
    enum: ['pending', 'processing', 'confirmed', 'dead', 'cancelled'],
    default: 'pending',
  },
  /** Set when a market is resolved and pending settlement is superseded. */
  cancelReason: { type: String, default: null },
  /** When true, off-chain OrderbookPosition was already updated at match time (avoid double-apply on confirm). */
  positionsLedgerApplied: { type: Boolean, default: false },
  txHash: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  processingStartedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

settlementOutboxSchema.index({ contractAddress: 1, status: 1, createdAt: 1 });
settlementOutboxSchema.index({ contractAddress: 1, chainMarketId: 1, createdAt: -1 });

settlementOutboxSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('SettlementOutbox', settlementOutboxSchema);
