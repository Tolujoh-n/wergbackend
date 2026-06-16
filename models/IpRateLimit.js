const mongoose = require('mongoose');

const ipRateLimitSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  windowStart: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

ipRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('IpRateLimit', ipRateLimitSchema);
