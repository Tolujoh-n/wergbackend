const mongoose = require('mongoose');

const predictionSchema = new mongoose.Schema({
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
    enum: ['free', 'boost', 'market'],
    required: true,
  },
  /** `amm` = legacy pool; `orderbook` = `outcome` like TeamA|YES */
  marketChannel: {
    type: String,
    enum: ['amm', 'orderbook'],
    default: 'amm',
  },
  outcome: {
    type: String,
    required: true,
  },
  /** Free predictions: tickets staked on this pick (jackpot weight). */
  ticketsStaked: {
    type: Number,
    default: 1,
    min: 1,
  },
  // Wallet that executed the on-chain action (boost/market) and will be used for claiming.
  // Stored lowercase for stable comparisons.
  walletAddress: {
    type: String,
  },
  amount: {
    type: Number,
    default: 0,
  },
  // For boost: track total stake (can be increased/decreased)
  totalStake: {
    type: Number,
    default: 0,
  },
  // Store original stake before resolution (for display after loss)
  originalStake: {
    type: Number,
    default: 0,
  },
  // For market: track shares owned
  shares: {
    type: Number,
    default: 0,
  },
  // For market: track total invested
  totalInvested: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'won', 'lost', 'settled'],
    default: 'pending',
  },
  payout: {
    type: Number,
    default: 0,
  },
  // Free predictions: amount received from the free jackpot pool at the last resolve.
  // Tracked so a result change (re-resolve) can reverse it exactly before redistributing.
  jackpotPayout: {
    type: Number,
    default: 0,
  },
  /** Free jackpot USDC claimed on-chain for this prediction row. */
  jackpotClaimed: {
    type: Boolean,
    default: false,
  },
  jackpotClaimInProgress: {
    type: Boolean,
    default: false,
  },
  jackpotClaimLockedAt: {
    type: Date,
  },
  jackpotClaimTxHash: {
    type: String,
  },
  claimed: {
    type: Boolean,
    default: false,
  },
  // Atomic claim guard: prevents a second on-chain claim authorization being issued
  // while one is already in flight (e.g. after an RPC timeout + user retry).
  claimInProgress: {
    type: Boolean,
    default: false,
  },
  claimLockedAt: {
    type: Date,
  },
  claimTxHash: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Prediction', predictionSchema);
