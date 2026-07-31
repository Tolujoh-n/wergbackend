const mongoose = require('mongoose');

/**
 * A wallet address can belong to exactly one user account.
 * A user account can have multiple wallet addresses.
 */
const walletLinkSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  /** Last successful gas drip to this wallet (any play type). */
  lastGasDripAt: {
    type: Date,
  },
  /** In-flight drip lock for this wallet. */
  gasDripLockUntil: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('WalletLink', walletLinkSchema);

