const mongoose = require('mongoose');

const abuseEventSchema = new mongoose.Schema(
  {
    signal: { type: String, required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    walletAddress: { type: String, lowercase: true, index: true },
    ip: { type: String, index: true },
    meta: { type: mongoose.Schema.Types.Mixed },
    banned: { type: Boolean, default: false },
    banReason: { type: String, default: '' },
  },
  { timestamps: true }
);

abuseEventSchema.index({ signal: 1, user: 1, createdAt: -1 });
abuseEventSchema.index({ signal: 1, ip: 1, createdAt: -1 });
abuseEventSchema.index({ signal: 1, walletAddress: 1, createdAt: -1 });

module.exports = mongoose.model('AbuseEvent', abuseEventSchema);
