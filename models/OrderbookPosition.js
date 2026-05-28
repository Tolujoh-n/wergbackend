const mongoose = require('mongoose');

const orderbookPositionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  walletAddress: { type: String, required: true, lowercase: true, trim: true },
  contractAddress: { type: String, lowercase: true, trim: true },
  chainMarketId: { type: Number, required: true },
  match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
  poll: { type: mongoose.Schema.Types.ObjectId, ref: 'Poll' },
  positionKey: { type: String, required: true },
  shares: { type: Number, default: 0 },
  totalInvested: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});

orderbookPositionSchema.index(
  { contractAddress: 1, chainMarketId: 1, walletAddress: 1, positionKey: 1 },
  { unique: true }
);

orderbookPositionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('OrderbookPosition', orderbookPositionSchema);
