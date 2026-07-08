const mongoose = require('mongoose');

/** One executed match leg at the maker's price (chart tape + analytics). */
const orderbookFillSchema = new mongoose.Schema({
  contractAddress: { type: String, lowercase: true, trim: true },
  chainMarketId: { type: Number, required: true, index: true },
  match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
  poll: { type: mongoose.Schema.Types.ObjectId, ref: 'Poll' },
  optionKey: { type: String, required: true },
  side: { type: String, enum: ['YES', 'NO'], required: true },
  /** Execution price (maker limit) in 0–1 probability units. */
  price: { type: Number, required: true },
  size: { type: Number, required: true },
  notional: { type: Number, default: 0 },
  takerDirection: { type: String, enum: ['buy', 'sell'], required: true },
  takerOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  makerOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  takerIsMarketMaker: { type: Boolean, default: false },
  makerIsMarketMaker: { type: Boolean, default: false },
  filledAt: { type: Date, default: Date.now, index: true },
});

orderbookFillSchema.index({ contractAddress: 1, chainMarketId: 1, filledAt: 1 });

module.exports = mongoose.model('OrderbookFill', orderbookFillSchema);
