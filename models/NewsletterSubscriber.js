const mongoose = require('mongoose');

const newsletterSubscriberSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  },
  source: {
    type: String,
    default: 'website',
    trim: true,
    maxlength: 120,
  },
  ip: {
    type: String,
    maxlength: 64,
  },
  userAgent: {
    type: String,
    maxlength: 500,
  },
  subscribedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

module.exports = mongoose.model('NewsletterSubscriber', newsletterSubscriberSchema);
