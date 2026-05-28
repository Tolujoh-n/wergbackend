const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  cup: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cup',
    required: true,
  },
  order: {
    type: Number,
    default: 0,
  },
  startDate: {
    type: Date,
  },
  endDate: {
    type: Date,
  },
  // Indicates the current active stage in the tournament timeline
  isCurrent: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Stage', stageSchema);
