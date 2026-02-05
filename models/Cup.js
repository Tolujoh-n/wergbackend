const mongoose = require('mongoose');

const cupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
  },
  description: {
    type: String,
  },
  status: {
    type: String,
    enum: ['upcoming', 'active', 'completed'],
    default: 'upcoming',
  },
  startDate: {
    type: Date,
  },
  endDate: {
    type: Date,
  },
  activeMatches: {
    type: Number,
    default: 0,
  },
  activePolls: {
    type: Number,
    default: 0,
  },
  showInNavbar: {
    type: Boolean,
    default: false,
  },
  navbarOrder: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Cup', cupSchema);
