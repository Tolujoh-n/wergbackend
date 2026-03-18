const mongoose = require('mongoose');

const MarketCommentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
    poll: { type: mongoose.Schema.Types.ObjectId, ref: 'Poll', default: null },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketComment', default: null },
    content: { type: String, required: true, trim: true, maxlength: 1000 },
    isDeleted: { type: Boolean, default: false },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

MarketCommentSchema.index({ match: 1, createdAt: -1 });
MarketCommentSchema.index({ poll: 1, createdAt: -1 });
MarketCommentSchema.index({ parent: 1, createdAt: 1 });

module.exports = mongoose.model('MarketComment', MarketCommentSchema);

