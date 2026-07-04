const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  referrer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  referredUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  referralCode: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
  },
  goldenTicketsAwarded: {
    type: Number,
    default: 0,
    min: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

referralSchema.index({ referrer: 1, createdAt: -1 });

module.exports = mongoose.model('Referral', referralSchema);
