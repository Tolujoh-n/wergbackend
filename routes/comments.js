const express = require('express');
const mongoose = require('mongoose');
const MarketComment = require('../models/MarketComment');
const { auth } = require('../middleware/auth');

const router = express.Router();

function buildThread(comments) {
  const byId = new Map();
  const roots = [];

  comments.forEach((c) => {
    byId.set(String(c._id), { ...c, replies: [] });
  });

  byId.forEach((c) => {
    if (c.parent) {
      const parent = byId.get(String(c.parent));
      if (parent) parent.replies.push(c);
      else roots.push(c);
    } else {
      roots.push(c);
    }
  });

  // Keep replies sorted by createdAt asc
  const sortReplies = (node) => {
    node.replies.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    node.replies.forEach(sortReplies);
  };
  roots.forEach(sortReplies);

  // Roots newest first (typical)
  roots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return roots;
}

/**
 * List market comments (market details page).
 * Query:
 * - type: 'match' | 'poll'
 * - itemId: Mongo ObjectId
 */
router.get('/market', async (req, res) => {
  try {
    const { type, itemId } = req.query;
    if (!['match', 'poll'].includes(type)) {
      return res.status(400).json({ message: 'type must be match or poll' });
    }
    if (!itemId || !mongoose.Types.ObjectId.isValid(String(itemId))) {
      return res.status(400).json({ message: 'Invalid itemId' });
    }

    const query = type === 'match' ? { match: itemId } : { poll: itemId };

    const comments = await MarketComment.find(query)
      .sort({ createdAt: -1 })
      .limit(300) // safety cap per market page
      .populate('user', 'username walletAddress role')
      .lean();

    const sanitized = comments.map((c) => {
      const likes = Array.isArray(c.likes) ? c.likes : [];
      return {
        _id: c._id,
        user: c.user,
        match: c.match,
        poll: c.poll,
        parent: c.parent,
        content: c.isDeleted ? '[deleted]' : c.content,
        isDeleted: !!c.isDeleted,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        likes,
        likeCount: likes.length,
      };
    });

    res.json({ comments: buildThread(sanitized) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * Create a comment or reply (auth required).
 * Body:
 * - type: 'match' | 'poll'
 * - itemId: Mongo ObjectId
 * - content: string
 * - parentId?: MarketComment id (for replies)
 */
router.post('/market', auth, async (req, res) => {
  try {
    const { type, itemId, content, parentId } = req.body || {};
    if (!['match', 'poll'].includes(type)) {
      return res.status(400).json({ message: 'type must be match or poll' });
    }
    if (!itemId || !mongoose.Types.ObjectId.isValid(String(itemId))) {
      return res.status(400).json({ message: 'Invalid itemId' });
    }
    const text = String(content || '').trim();
    if (!text) {
      return res.status(400).json({ message: 'Comment cannot be empty' });
    }
    if (text.length > 1000) {
      return res.status(400).json({ message: 'Comment is too long (max 1000 chars)' });
    }

    let parent = null;
    if (parentId) {
      if (!mongoose.Types.ObjectId.isValid(String(parentId))) {
        return res.status(400).json({ message: 'Invalid parentId' });
      }
      const parentDoc = await MarketComment.findById(parentId).lean();
      if (!parentDoc) {
        return res.status(404).json({ message: 'Parent comment not found' });
      }
      // Parent must belong to same market item
      if (type === 'match' && String(parentDoc.match || '') !== String(itemId)) {
        return res.status(400).json({ message: 'Parent comment does not belong to this match' });
      }
      if (type === 'poll' && String(parentDoc.poll || '') !== String(itemId)) {
        return res.status(400).json({ message: 'Parent comment does not belong to this poll' });
      }
      parent = parentDoc._id;
    }

    const doc = await MarketComment.create({
      user: req.user._id,
      match: type === 'match' ? itemId : null,
      poll: type === 'poll' ? itemId : null,
      parent,
      content: text,
    });

    const populated = await MarketComment.findById(doc._id)
      .populate('user', 'username walletAddress role')
      .lean();

    res.status(201).json({
      comment: {
        _id: populated._id,
        user: populated.user,
        match: populated.match,
        poll: populated.poll,
        parent: populated.parent,
        content: populated.content,
        isDeleted: !!populated.isDeleted,
        createdAt: populated.createdAt,
        updatedAt: populated.updatedAt,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * Soft-delete a comment (owner or admin/superAdmin).
 */
router.delete('/market/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'Invalid id' });
    }

    const comment = await MarketComment.findById(id);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const isOwner = String(comment.user) === String(req.user._id);
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superAdmin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }

    comment.isDeleted = true;
    comment.content = '[deleted]';
    await comment.save();

    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * Toggle like on a comment (auth required).
 * POST /api/comments/market/:id/like
 */
router.post('/market/:id/like', auth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ message: 'Invalid id' });
    }

    const comment = await MarketComment.findById(id);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const userId = String(req.user._id);
    const likes = comment.likes || [];
    const alreadyLiked = likes.some((u) => String(u) === userId);

    if (alreadyLiked) {
      comment.likes = likes.filter((u) => String(u) !== userId);
    } else {
      comment.likes.push(req.user._id);
    }

    await comment.save();

    return res.json({
      liked: !alreadyLiked,
      likeCount: comment.likes.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;

