const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  walletAddress: { type: String, required: true, lowercase: true, trim: true },
  contractAddress: { type: String, lowercase: true, trim: true },
  chainMarketId: { type: Number, required: true },
  match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
  poll: { type: mongoose.Schema.Types.ObjectId, ref: 'Poll' },
  /** Contract outcome key: TeamA, TeamB, Draw, or poll option text */
  optionKey: { type: String, required: true },
  side: { type: String, enum: ['YES', 'NO'], required: true },
  /** buy = acquire side token; sell = exit */
  direction: { type: String, enum: ['buy', 'sell'], required: true },
  orderKind: { type: String, enum: ['limit', 'market'], required: true },
  /** Limit price 0–1 (probability); market uses aggressive computed price */
  limitPrice: { type: Number, default: null },
  /** Original size in “share” units (USDC decimal semantics aligned with platform) */
  sizeOriginal: { type: Number, required: true },
  sizeRemaining: { type: Number, required: true },
  sizeFilled: { type: Number, default: 0 },
  /** Max unfavorable price move for market / partial fills (basis points) */
  slippageBps: { type: Number, default: 100 },
  status: {
    type: String,
    enum: ['pending', 'open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected'],
    default: 'pending',
  },
  expiresAt: { type: Date, default: null },
  isMarketMaker: { type: Boolean, default: false },
  /** USDC reserved in vault for this order (buys) */
  reservedCollateral: { type: Number, default: 0 },
  /** Cumulative fees charged on fills (USDC) */
  feesPaid: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  settlementTxHashes: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

orderSchema.index({ contractAddress: 1, chainMarketId: 1, optionKey: 1, side: 1, status: 1 });
orderSchema.index({ user: 1, status: 1, createdAt: -1 });
orderSchema.index({ walletAddress: 1, status: 1 });

orderSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Order', orderSchema);
