const mongoose = require('mongoose');

const goldenTicketDailyGrantSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  ticketsPerDay: {
    type: Number,
    required: true,
    min: 1,
  },
  /** Total calendar days to grant (UTC). */
  daysTotal: {
    type: Number,
    required: true,
    min: 1,
  },
  /** Days already granted (including first grant on create). */
  daysGranted: {
    type: Number,
    default: 0,
  },
  startDate: {
    type: Date,
    required: true,
  },
  endDate: {
    type: Date,
    required: true,
  },
  lastGrantedUtcDay: {
    type: Date,
    default: null,
  },
  active: {
    type: Boolean,
    default: true,
    index: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  recipientEmail: { type: String, trim: true },
  recipientWallet: { type: String, trim: true, lowercase: true },
  note: { type: String, trim: true },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

goldenTicketDailyGrantSchema.index({ active: 1, endDate: 1 });

module.exports = mongoose.model('GoldenTicketDailyGrant', goldenTicketDailyGrantSchema);
