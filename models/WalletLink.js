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
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('WalletLink', walletLinkSchema);

