const express = require('express');
const multer = require('multer');
const { auth, isAdmin } = require('../middleware/auth');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Cup = require('../models/Cup');
const Stage = require('../models/Stage');
const Prediction = require('../models/Prediction');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Blog = require('../models/Blog');
const Settings = require('../models/Settings');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const { uploadImage, deleteImage } = require('../utils/cloudinary');
const { scheduleMarketMakerSeed } = require('../services/marketMakerQuotes');
const { normalizeStartingPricesRows } = require('../utils/targetOdds');
const { orderbookContractAddressLower } = require('../utils/orderbookContractScope');
const { resolveUserByIdentifier } = require('../utils/resolveUserByIdentifier');
const { awardGoldenTickets } = require('../services/ticketService');
const {
  createDailyGoldenTicketGrant,
  listActiveGrants,
  cancelGrant,
} = require('../services/goldenTicketDailyGrantService');
const { normalizeSponsoredImages } = require('../utils/sponsoredImages');
const {
  distributeFreeJackpotTopUp,
  distributeBoostPoolTopUp,
  getTicketTotalsByEvent,
  displayJackpotPools,
} = require('../utils/poolDistribution');
const { deferJackpotOnChainSync } = require('../utils/jackpotOnChainSync');

/** On-chain vault sweep runs in background so resolve HTTP doesn't hit proxy timeouts. */
function deferOrderbookFinalize(item) {
  if (item?.marketId == null) return;
  const snapshot = { marketId: item.marketId, _id: item._id };
  setImmediate(() => {
    const { finalizeOrderbookMarketOnResolve } = require('../services/orderbookMarketFinalize');
    finalizeOrderbookMarketOnResolve(snapshot)
      .then((fin) => {
        if (fin?.txHash) console.log('orderbook finalize (background):', fin.txHash);
      })
      .catch((e) => console.error('orderbook finalize (background):', e?.message || e));
  });
}

/** Orderbook winner rows + vault reads can be slow; run after HTTP response. */
function deferOrderbookResolutionPredictions({ item, kind, winningOptionKey, totalMarketLiquidity }) {
  if (item?.marketId == null || item?._id == null) return;
  const snapshot = {
    itemId: item._id,
    kind,
    winningOptionKey,
    totalMarketLiquidity,
  };
  setImmediate(async () => {
    try {
      const Model = kind === 'match' ? Match : Poll;
      const fresh = await Model.findById(snapshot.itemId);
      if (!fresh) return;
      const { createOrderbookResolutionPredictions } = require('../services/orderbookResolution');
      await createOrderbookResolutionPredictions({
        item: fresh,
        kind: snapshot.kind,
        winningOptionKey: snapshot.winningOptionKey,
        totalMarketLiquidity: snapshot.totalMarketLiquidity,
      });
    } catch (e) {
      console.error('orderbook resolution predictions (background):', e?.message || e);
    }
  });
}

async function loadUsersWalletMap(userIds) {
  const unique = [...new Set(userIds.map((id) => String(id)).filter(Boolean))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select('walletAddress jackpotBalance').lean();
  return new Map(users.map((u) => [u._id.toString(), u]));
}

function buildClaimableWalletPayloads(predsForClaim, usersById) {
  const claimableByWallet = {};
  const claimableBoostByWallet = {};
  const claimableMarketByWallet = {};
  for (const p of predsForClaim) {
    const userId = p.user?._id ? p.user._id : p.user;
    if (!userId) continue;
    const user = usersById.get(String(userId));
    const walletAddress = user?.walletAddress || p.user?.walletAddress;
    if (!walletAddress || !String(walletAddress).trim()) continue;
    const w = String(walletAddress).trim();
    const payout = p.payout || 0;
    claimableByWallet[w] = (claimableByWallet[w] || 0) + payout;
    if (p.type === 'boost') {
      claimableBoostByWallet[w] = (claimableBoostByWallet[w] || 0) + payout;
    } else {
      claimableMarketByWallet[w] = (claimableMarketByWallet[w] || 0) + payout;
    }
  }
  return {
    claimableUpdates: Object.entries(claimableByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount })),
    claimableBoostUpdates: Object.entries(claimableBoostByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount })),
    claimableMarketUpdates: Object.entries(claimableMarketByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount })),
  };
}

const router = express.Router();

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// All admin routes require authentication and admin role
router.use(auth);
router.use(isAdmin);

// Get claimable updates for a match (used when resolving - same data as resolve response)
router.get('/claimable-updates/matches/:id', async (req, res) => {
  try {
    const match = await Match.findById(req.params.id);
    if (!match || !match.marketId) {
      return res.status(404).json({ message: 'Match not found or no marketId' });
    }
    const predsForClaim = await Prediction.find({
      match: match._id,
      type: { $in: ['boost', 'market'] },
      status: 'settled',
      payout: { $gt: 0 },
    });
    const claimableByWallet = {};
    const claimableBoostByWallet = {};
    const claimableMarketByWallet = {};
    for (const p of predsForClaim) {
      const userId = p.user?._id ? p.user._id : p.user;
      if (!userId) continue;
      const walletAddress = p.walletAddress && String(p.walletAddress).trim()
        ? String(p.walletAddress).trim()
        : null;
      let w = walletAddress ? String(walletAddress).trim() : null;
      if (!w) {
        // Backward compatibility: fall back to legacy user.walletAddress or the first linked wallet.
        const user = await User.findById(userId).select('walletAddress').lean();
        w = user?.walletAddress ? String(user.walletAddress).trim() : null;
        if (!w) {
          const link = await WalletLink.findOne({ user: userId }).select('walletAddress').lean();
          w = link?.walletAddress ? String(link.walletAddress).trim() : null;
        }
      }
      if (!w) continue;
      const payout = p.payout || 0;
      claimableByWallet[w] = (claimableByWallet[w] || 0) + payout;
      if (p.type === 'boost') {
        claimableBoostByWallet[w] = (claimableBoostByWallet[w] || 0) + payout;
      } else {
        claimableMarketByWallet[w] = (claimableMarketByWallet[w] || 0) + payout;
      }
    }
    const claimableUpdates = Object.entries(claimableByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    const claimableBoostUpdates = Object.entries(claimableBoostByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    const claimableMarketUpdates = Object.entries(claimableMarketByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    res.json({ marketId: match.marketId, claimableUpdates, claimableBoostUpdates, claimableMarketUpdates });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get claimable updates for a poll (used when resolving - same data as resolve response)
router.get('/claimable-updates/polls/:id', async (req, res) => {
  try {
    const poll = await Poll.findById(req.params.id);
    if (!poll || !poll.marketId) {
      return res.status(404).json({ message: 'Poll not found or no marketId' });
    }
    const predsForClaim = await Prediction.find({
      poll: poll._id,
      type: { $in: ['boost', 'market'] },
      status: 'settled',
      payout: { $gt: 0 },
    });
    const claimableByWallet = {};
    const claimableBoostByWallet = {};
    const claimableMarketByWallet = {};
    for (const p of predsForClaim) {
      const userId = p.user?._id ? p.user._id : p.user;
      if (!userId) continue;
      const walletAddress = p.walletAddress && String(p.walletAddress).trim()
        ? String(p.walletAddress).trim()
        : null;
      let w = walletAddress ? String(walletAddress).trim() : null;
      if (!w) {
        const user = await User.findById(userId).select('walletAddress').lean();
        w = user?.walletAddress ? String(user.walletAddress).trim() : null;
        if (!w) {
          const link = await WalletLink.findOne({ user: userId }).select('walletAddress').lean();
          w = link?.walletAddress ? String(link.walletAddress).trim() : null;
        }
      }
      if (!w) continue;
      const payout = p.payout || 0;
      claimableByWallet[w] = (claimableByWallet[w] || 0) + payout;
      if (p.type === 'boost') {
        claimableBoostByWallet[w] = (claimableBoostByWallet[w] || 0) + payout;
      } else {
        claimableMarketByWallet[w] = (claimableMarketByWallet[w] || 0) + payout;
      }
    }
    const claimableUpdates = Object.entries(claimableByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    const claimableBoostUpdates = Object.entries(claimableBoostByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    const claimableMarketUpdates = Object.entries(claimableMarketByWallet).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    res.json({ marketId: poll.marketId, claimableUpdates, claimableBoostUpdates, claimableMarketUpdates });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Admin dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const totalMatches = await Match.countDocuments();
    const totalPolls = await Poll.countDocuments();
    const totalUsers = await User.countDocuments();
    const totalPredictions = await Prediction.countDocuments();
    const activeMatches = await Match.countDocuments({ status: { $in: ['upcoming', 'live'] } });
    const totalBlogs = await Blog.countDocuments();
    
    res.json({
      totalMatches,
      totalPolls,
      totalUsers,
      totalPredictions,
      activeMatches,
      totalBlogs,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Blog Management
router.get('/blogs', async (req, res) => {
  try {
    const blogs = await Blog.find()
      .populate('author', 'username')
      .sort({ createdAt: -1 });
    res.json(blogs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/blogs', async (req, res) => {
  try {
    // Accept Tiptap format (JSON with type: 'doc') or old Slate format
    const normalizeContent = (content) => {
      if (!content) {
        // Return Tiptap default format
        return {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [],
            },
          ],
        };
      }
      
      // If it's already a valid Tiptap format (has type: 'doc')
      if (typeof content === 'object' && content.type === 'doc') {
        return content;
      }
      
      // If it's a string, try to parse it
      if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          // If it's Tiptap format
          if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
            return parsed;
          }
          // If it's old Slate format (array)
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed; // Keep old format for backward compatibility
          }
        } catch (e) {
          // If parsing fails, convert plain text to Tiptap format
          return {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: content }],
              },
            ],
          };
        }
      }
      
      // If it's already an array (old Slate format), keep it for backward compatibility
      if (Array.isArray(content) && content.length > 0) {
        return content;
      }
      
      // Default fallback - Tiptap format
      return {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [],
          },
        ],
      };
    };

    // Generate slug from title if not provided
    let slug = req.body.slug;
    if (!slug && req.body.title) {
      const baseSlug = req.body.title.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      
      // Check if slug exists, if so add number suffix
      slug = baseSlug;
      let counter = 1;
      while (true) {
        const existingBlog = await Blog.findOne({ slug: slug });
        if (!existingBlog) {
          break;
        }
        slug = `${baseSlug}-${counter}`;
        counter++;
      }
    }

    const blogData = {
      ...req.body,
      slug: slug || req.body.slug,
      content: normalizeContent(req.body.content),
      author: req.user._id,
      publishedAt: req.body.isPublished ? new Date() : null,
    };
    const blog = new Blog(blogData);
    await blog.save();
    await blog.populate('author', 'username');
    res.status(201).json(blog);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/blogs/:id', async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    // Normalize content if provided
    if (req.body.content !== undefined) {
      const normalizeContent = (content) => {
        if (!content) {
          // Return Tiptap default format
          return {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [],
              },
            ],
          };
        }
        
        // If it's already a valid Tiptap format (has type: 'doc')
        if (typeof content === 'object' && content.type === 'doc') {
          return content;
        }
        
        // If it's a string, try to parse it
        if (typeof content === 'string') {
          try {
            const parsed = JSON.parse(content);
            // If it's Tiptap format
            if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
              return parsed;
            }
            // If it's old Slate format (array)
            if (Array.isArray(parsed) && parsed.length > 0) {
              return parsed; // Keep old format for backward compatibility
            }
          } catch (e) {
            // If parsing fails, convert plain text to Tiptap format
            return {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: content }],
                },
              ],
            };
          }
        }
        
        // If it's already an array (old Slate format), keep it for backward compatibility
        if (Array.isArray(content) && content.length > 0) {
          return content;
        }
        
        // Default fallback - Tiptap format
        return {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [],
            },
          ],
        };
      };
      
      req.body.content = normalizeContent(req.body.content);
    }

    // If publishing for the first time, set publishedAt
    if (req.body.isPublished && !blog.isPublished) {
      req.body.publishedAt = new Date();
    }

    Object.assign(blog, req.body);
    await blog.save();
    await blog.populate('author', 'username');
    res.json(blog);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/blogs/:id', async (req, res) => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }
    res.json({ message: 'Blog deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Image upload endpoint
router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    const folder = req.body.folder || 'wergame';
    const uploadResult = await uploadImage(req.file, { folder });

    res.json({
      url: uploadResult.url,
      public_id: uploadResult.public_id,
    });
  } catch (error) {
    console.error('Image upload error:', error);
    res.status(500).json({ message: error.message || 'Failed to upload image' });
  }
});

// Create Match with liquidity
router.post('/matches', async (req, res) => {
  try {
    const {
      teamA,
      teamB,
      date,
      cup,
      stage,
      stageName,
      description,
      marketId,
      marketTeamALiquidity,
      marketTeamBLiquidity,
      marketDrawLiquidity,
      yesNo,
      isFeatured,
      isSponsored,
      sponsoredImages,
      lockedTime,
      teamAImage,
      teamBImage,
      marketInitialized,
      minFreeTickets,
      freePredictionEnabled,
      marketEnabled,
      drawEnabled,
      startingPrices,
    } = req.body;

    const cupDoc = typeof cup === 'string' ? await Cup.findById(cup) : await Cup.findOne({ slug: cup });
    if (!cupDoc) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    let stageDoc = null;
    if (stage) {
      stageDoc = typeof stage === 'string' ? await Stage.findById(stage) : stage;
    }

    // Normalize YES/NO seed liquidity rows (orderbook reference liquidity)
    const seedRows = Array.isArray(yesNo)
      ? yesNo
          .map((r) => ({
            optionKey: String(r?.option || r?.optionKey || '').trim(),
            yes: parseFloat(r?.yesAmount ?? r?.yes) || 0,
            no: parseFloat(r?.noAmount ?? r?.no) || 0,
          }))
          .filter((r) => r.optionKey && (r.yes > 0 || r.no > 0))
      : [];

    const sumFor = (key) => {
      const r = seedRows.find((x) => x.optionKey === key);
      return r ? (r.yes || 0) + (r.no || 0) : 0;
    };

    const match = new Match({
      teamA,
      teamB,
      date: new Date(date),
      cup: cupDoc._id,
      stage: stageDoc?._id,
      stageName: stageDoc?.name || stageName,
      description: description ? String(description).trim() : '',
      marketId: marketId ? parseInt(marketId, 10) : undefined,
      ...(orderbookContractAddressLower() ? { contractAddress: orderbookContractAddressLower() } : {}),
      // Legacy liquidity fields kept for backward compatibility; we store sum(YES+NO) per outcome here.
      marketTeamALiquidity: (marketTeamALiquidity || 0) + sumFor('TeamA'),
      marketTeamBLiquidity: (marketTeamBLiquidity || 0) + sumFor('TeamB'),
      marketDrawLiquidity: (marketDrawLiquidity || 0) + sumFor('Draw'),
      marketInitialized:
        marketInitialized !== undefined
          ? marketInitialized
          : (seedRows.length > 0 ||
              marketTeamALiquidity > 0 ||
              marketTeamBLiquidity > 0 ||
              marketDrawLiquidity > 0),
      minFreeTickets: Math.max(1, parseInt(minFreeTickets, 10) || 1),
      freePredictionEnabled: freePredictionEnabled !== false,
      marketEnabled: marketEnabled !== false,
      drawEnabled: drawEnabled !== false,
      startingPrices: normalizeStartingPricesRows(Array.isArray(startingPrices) ? startingPrices : []),
      isFeatured: isFeatured || false,
      isSponsored: isSponsored || false,
      sponsoredImages: normalizeSponsoredImages(sponsoredImages),
      lockedTime: lockedTime && lockedTime.trim() !== '' ? new Date(lockedTime) : undefined,
      teamAImage: teamAImage || undefined,
      teamBImage: teamBImage || undefined,
    });

    if (seedRows.length > 0) {
      match.orderbook = match.orderbook || {};
      match.orderbook.liquidityYesNo = seedRows;
    }

    await match.save();
    
    // Update cup active matches count
    cupDoc.activeMatches = await Match.countDocuments({ cup: cupDoc._id, status: { $in: ['upcoming', 'live'] } });
    await cupDoc.save();

    if (match.marketId) {
      scheduleMarketMakerSeed({ kind: 'match', id: match._id });
    }

    res.status(201).json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Match
router.put('/matches/:id', async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.sponsoredImages !== undefined) {
      updates.sponsoredImages = normalizeSponsoredImages(updates.sponsoredImages);
    }
    if (updates.description !== undefined) {
      updates.description = String(updates.description || '').trim();
    }
    const match = await Match.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add liquidity to match market
router.post('/matches/:id/liquidity', async (req, res) => {
  try {
    const { teamALiquidity, teamBLiquidity, drawLiquidity, yesNo } = req.body;
    const match = await Match.findById(req.params.id);
    
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    match.marketTeamALiquidity += teamALiquidity || 0;
    match.marketTeamBLiquidity += teamBLiquidity || 0;
    match.marketDrawLiquidity += drawLiquidity || 0;
    match.marketInitialized = true;

    if (Array.isArray(yesNo) && yesNo.length > 0) {
      match.orderbook = match.orderbook || {};
      const list = Array.isArray(match.orderbook.liquidityYesNo) ? [...match.orderbook.liquidityYesNo] : [];
      for (const row of yesNo) {
        const key = String(row.option || '').trim();
        if (!key) continue;
        const y = parseFloat(row.yesAmount) || 0;
        const n = parseFloat(row.noAmount) || 0;
        if (y <= 0 && n <= 0) continue;
        const ix = list.findIndex((x) => x.optionKey === key);
        if (ix >= 0) {
          list[ix].yes = (list[ix].yes || 0) + y;
          list[ix].no = (list[ix].no || 0) + n;
        } else {
          list.push({ optionKey: key, yes: y, no: n });
        }
      }
      match.orderbook.liquidityYesNo = list;
    }
    
    await match.save();
    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete Match
router.delete('/matches/:id', async (req, res) => {
  try {
    const match = await Match.findByIdAndDelete(req.params.id);
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    res.json({ message: 'Match deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Resolve Match
router.post('/matches/:id/resolve', async (req, res) => {
  try {
    let { result, reResolve } = req.body;
    
    const match = await Match.findById(req.params.id);
    
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const wasAlreadyResolved = match.isResolved === true;
    const isReResolve = wasAlreadyResolved || reResolve === true;

    if (isReResolve && wasAlreadyResolved) {
      const existing = await Prediction.find({ match: match._id });
      const reverseFreeByUser = new Map();
      const bulkOps = [];
      for (const prediction of existing) {
        if (prediction.type === 'free' && (prediction.jackpotPayout || 0) > 0) {
          const uid = prediction.user.toString();
          reverseFreeByUser.set(uid, (reverseFreeByUser.get(uid) || 0) + prediction.jackpotPayout);
        }
        if (prediction.type === 'boost' || prediction.type === 'free' || prediction.type === 'market') {
          const $set = {
            status: 'pending',
            payout: 0,
            claimed: false,
            jackpotPayout: 0,
            jackpotClaimed: false,
            jackpotClaimInProgress: false,
            claimInProgress: false,
          };
          if (prediction.type === 'boost' && (prediction.originalStake || 0) > 0) {
            $set.totalStake = prediction.originalStake;
            $set.amount = prediction.originalStake;
          }
          bulkOps.push({ updateOne: { filter: { _id: prediction._id }, update: { $set } } });
        }
      }
      if (bulkOps.length) {
        await Prediction.bulkWrite(bulkOps, { ordered: false });
      }
      for (const [uid, amt] of reverseFreeByUser.entries()) {
        await User.updateOne(
          { _id: uid },
          {
            $inc: { jackpotBalance: -amt, jackpotWins: -1 },
          }
        );
        await User.updateOne(
          { _id: uid, jackpotBalance: { $lt: 0 } },
          { $set: { jackpotBalance: 0 } }
        );
        await User.updateOne(
          { _id: uid, jackpotWins: { $lt: 0 } },
          { $set: { jackpotWins: 0 } }
        );
      }
      match.freeJackpotPool = (match.originalFreeJackpotPool || 0) + (match.freeJackpotPool || 0);
    }

    // Normalize result - accept teamA, teamB, draw (case-insensitive) or team names
    const resultLower = result ? result.toLowerCase() : '';
    let normalizedResult = '';
    
    if (resultLower === 'teama' || result === match.teamA) {
      normalizedResult = 'TeamA';
    } else if (resultLower === 'teamb' || result === match.teamB) {
      normalizedResult = 'TeamB';
    } else if (resultLower === 'draw' || result === 'Draw') {
      normalizedResult = 'Draw';
    } else {
      return res.status(400).json({ message: 'Invalid result. Must be teamA, teamB, or draw' });
    }

    // Calculate total liquidity from all options
    const totalMarketLiquidity = (match.marketTeamALiquidity || 0) + (match.marketTeamBLiquidity || 0) + (match.marketDrawLiquidity || 0);
    const totalBoostPool = match.boostPool || 0;
    
    // Move all liquidity to winning option
    if (normalizedResult === 'TeamA') {
      match.marketTeamALiquidity = totalMarketLiquidity;
      match.marketTeamBLiquidity = 0;
      match.marketDrawLiquidity = 0;
    } else if (normalizedResult === 'TeamB') {
      match.marketTeamBLiquidity = totalMarketLiquidity;
      match.marketTeamALiquidity = 0;
      match.marketDrawLiquidity = 0;
    } else if (normalizedResult === 'Draw') {
      match.marketDrawLiquidity = totalMarketLiquidity;
      match.marketTeamALiquidity = 0;
      match.marketTeamBLiquidity = 0;
    }
    
    match.result = normalizedResult;
    match.status = 'completed';
    match.isResolved = true;
    await match.save();

    // Update all prediction types
    const predictions = await Prediction.find({ match: match._id });
    const boostPredictions = [];
    const marketWinningPredictions = [];
    const predictionBulkOps = [];

    // First pass: determine win/loss status and collect predictions (don't save yet)
    for (const prediction of predictions) {
      // Normalize outcome for comparison - handle both team names and normalized values
      let normalizedPredictionOutcome = '';
      const predictionOutcome = (prediction.outcome || '').trim();
      
      // Check if prediction outcome matches team names directly
      if (predictionOutcome === match.teamA || predictionOutcome.toLowerCase() === match.teamA.toLowerCase()) {
        normalizedPredictionOutcome = 'TeamA';
      } else if (predictionOutcome === match.teamB || predictionOutcome.toLowerCase() === match.teamB.toLowerCase()) {
        normalizedPredictionOutcome = 'TeamB';
      } else if (predictionOutcome.toLowerCase() === 'draw') {
        normalizedPredictionOutcome = 'Draw';
      } else {
        // Try to normalize the outcome string
        const normalizedOutcome = predictionOutcome.charAt(0).toUpperCase() + predictionOutcome.slice(1).toLowerCase();
        normalizedPredictionOutcome = normalizedOutcome === 'Teama' ? 'TeamA' : (normalizedOutcome === 'Teamb' ? 'TeamB' : normalizedOutcome);
      }
      
      if (normalizedPredictionOutcome === normalizedResult) {
        prediction.status = 'won';
      } else {
        prediction.status = 'lost';
        // For losing market predictions, set shares to 0 (only on first resolve)
        if (prediction.type === 'market' && !wasAlreadyResolved) {
          prediction.shares = 0;
        }
        // Note: Don't zero out boost losing stakes yet - we need them for payout calculation
      }
      
      // For market predictions, calculate payout based on shares in winning option
      if (prediction.type === 'market') {
        if (prediction.status === 'won') {
          marketWinningPredictions.push(prediction);
        } else {
          // Losing predictions get 0 payout
          prediction.payout = 0;
          prediction.status = 'settled';
        }
      }
      
      if (prediction.type === 'boost') {
        boostPredictions.push(prediction);
      }

      if (prediction.type === 'free') {
        predictionBulkOps.push({
          updateOne: {
            filter: { _id: prediction._id },
            update: { $set: { status: prediction.status } },
          },
        });
      } else if (prediction.type === 'market' && prediction.status !== 'won') {
        predictionBulkOps.push({
          updateOne: {
            filter: { _id: prediction._id },
            update: {
              $set: {
                payout: prediction.payout,
                status: prediction.status,
                shares: prediction.shares,
              },
            },
          },
        });
      }
    }

    if (predictionBulkOps.length > 0) {
      await Prediction.bulkWrite(predictionBulkOps, { ordered: false });
    }

    // Winning market shares pay $1 USDC each at resolution
    if (marketWinningPredictions.length > 0) {
      await Prediction.bulkWrite(
        marketWinningPredictions.map((prediction) => {
          const shares = Number(prediction.shares) || 0;
          const payout = shares > 0 ? Math.round(shares * 100) / 100 : 0;
          prediction.payout = payout;
          prediction.status = 'settled';
          return {
            updateOne: {
              filter: { _id: prediction._id },
              update: { $set: { payout, status: 'settled' } },
            },
          };
        }),
        { ordered: false }
      );
    }

    deferOrderbookResolutionPredictions({
      item: match,
      kind: 'match',
      winningOptionKey: normalizedResult,
      totalMarketLiquidity,
    });

    // Boost: winners split the full boostPool (net stakes + admin top-ups) by stake weight.
    // Runs on first resolve AND on a result change so the pool follows the new winners.
    match.originalBoostPool = match.boostPool || 0;
    if (boostPredictions.length > 0) {
      const { applyBoostPoolPayouts } = require('../utils/boostPayout');
      applyBoostPoolPayouts({ boostPool: match.boostPool, boostPredictions });
      await Prediction.bulkWrite(
        boostPredictions.map((p) => ({
          updateOne: {
            filter: { _id: p._id },
            update: {
              $set: {
                payout: p.payout,
                status: p.status,
                originalStake: p.originalStake,
                amount: p.amount,
                totalStake: p.totalStake,
              },
            },
          },
        })),
        { ordered: false }
      );
    }

    // Free jackpot: distribute by tickets to the winners. Runs on first resolve AND on a
    // result change (the pool was reconstituted + reversed above for re-resolve).
    match.originalFreeJackpotPool = match.freeJackpotPool || 0;
    {
      const freeJackpotPoolAmount = match.freeJackpotPool || 0;
      const freeWinningPredictions = predictions.filter((p) => p.type === 'free' && p.status === 'won');
      if (freeWinningPredictions.length > 0 && freeJackpotPoolAmount > 0) {
        let totalTickets = 0;
        for (const p of freeWinningPredictions) {
          totalTickets += Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
        }
        const perTicket = totalTickets > 0 ? freeJackpotPoolAmount / totalTickets : 0;
        const perUser = new Map();
        const jackpotBulkOps = [];
        for (const p of freeWinningPredictions) {
          const t = Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
          const amt = perTicket * t;
          p.jackpotPayout = amt;
          jackpotBulkOps.push({
            updateOne: {
              filter: { _id: p._id },
              update: { $set: { jackpotPayout: amt } },
            },
          });
          const uid = p.user.toString();
          perUser.set(uid, (perUser.get(uid) || 0) + amt);
        }
        if (jackpotBulkOps.length) {
          await Prediction.bulkWrite(jackpotBulkOps, { ordered: false });
        }
        const userJackpotOps = [];
        for (const [userId, amount] of perUser.entries()) {
          if (amount > 0) {
            userJackpotOps.push({
              updateOne: {
                filter: { _id: userId },
                update: { $inc: { jackpotBalance: amount, jackpotWins: 1 } },
              },
            });
          }
        }
        if (userJackpotOps.length) {
          await User.bulkWrite(userJackpotOps, { ordered: false });
          deferJackpotOnChainSync([...perUser.keys()]);
        }
        match.freeJackpotPool = 0;
      }
    }

    // Award points to winning free predictions (first resolve only — avoid inflation on re-resolve)
    if (!wasAlreadyResolved) {
    const freeWinningPredictionsForPoints = predictions.filter(p => p.type === 'free' && p.status === 'won');
    if (freeWinningPredictionsForPoints.length > 0) {
      const pointsPerWinSetting = await Settings.findOne({ key: 'pointsPerWin' });
      const pointsPerWin = pointsPerWinSetting ? (typeof pointsPerWinSetting.value === 'number' ? pointsPerWinSetting.value : parseFloat(pointsPerWinSetting.value) || 10) : 10;
      
      const userIds = [...new Set(freeWinningPredictionsForPoints.map(p => p.user.toString()))];
      const pointsByUser = new Map();
      for (const p of freeWinningPredictionsForPoints) {
        const uid = p.user.toString();
        pointsByUser.set(uid, (pointsByUser.get(uid) || 0) + pointsPerWin);
      }
      const pointsOps = [...pointsByUser.entries()].map(([userId, pts]) => ({
        updateOne: {
          filter: { _id: userId },
          update: { $inc: { points: pts } },
        },
      }));
      if (pointsOps.length) {
        await User.bulkWrite(pointsOps, { ordered: false });
      }
    }
    }

    await match.save();

    // Build claimable (boost + market separate) and jackpot updates for frontend to set on blockchain
    const predsForClaim = await Prediction.find({
      match: match._id,
      type: { $in: ['boost', 'market'] },
      status: 'settled',
      payout: { $gt: 0 },
    }).lean();
    const claimUserIds = predsForClaim.map((p) => p.user).filter(Boolean);
    const usersById = await loadUsersWalletMap(claimUserIds);
    const {
      claimableUpdates,
      claimableBoostUpdates,
      claimableMarketUpdates,
    } = buildClaimableWalletPayloads(predsForClaim, usersById);
    const jackpotUserIds = [...new Set(
      predictions
        .filter((p) => (p.type === 'free' || p.type === 'boost') && p.status === 'won')
        .map((p) => p.user?.toString())
        .filter(Boolean)
    )];
    const jackpotUsersById = await loadUsersWalletMap(jackpotUserIds);
    const jackpotUpdates = [];
    for (const uid of jackpotUserIds) {
      const user = jackpotUsersById.get(uid);
      if (user?.walletAddress && (user.jackpotBalance || 0) > 0) {
        jackpotUpdates.push({ walletAddress: user.walletAddress, amount: user.jackpotBalance });
      }
    }

    res.json({ match, claimableUpdates, claimableBoostUpdates, claimableMarketUpdates, jackpotUpdates });

    if (!wasAlreadyResolved) {
      deferOrderbookFinalize(match);
    }
  } catch (error) {
    console.error('resolve match:', error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || 'Resolve failed' });
    }
  }
});

// Create Poll with liquidity
router.post('/polls', async (req, res) => {
  try {
    const {
      question,
      description,
      thumbnailImage,
      type,
      cup,
      stage,
      marketId,
      marketYesLiquidity,
      marketNoLiquidity,
      isFeatured,
      isSponsored,
      sponsoredImages,
      date,
      lockedTime,
      optionType,
      options,
      marketInitialized,
      minFreeTickets,
      freePredictionEnabled,
      marketEnabled,
      startingPrices,
    } = req.body;

    const cupDoc = typeof cup === 'string' ? await Cup.findById(cup) : await Cup.findOne({ slug: cup });
    if (!cupDoc) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    let stageDoc = null;
    if (stage) {
      stageDoc = typeof stage === 'string' ? await Stage.findById(stage) : stage;
    }

    const pollData = {
      question,
      description,
      thumbnailImage: thumbnailImage || undefined,
      type,
      cup: cupDoc._id,
      stage: stageDoc?._id,
      date: date && String(date).trim() !== '' ? new Date(date) : undefined,
      marketId: marketId ? parseInt(marketId, 10) : undefined,
      ...(orderbookContractAddressLower() ? { contractAddress: orderbookContractAddressLower() } : {}),
      minFreeTickets: Math.max(1, parseInt(minFreeTickets, 10) || 1),
      freePredictionEnabled: freePredictionEnabled !== false,
      marketEnabled: marketEnabled !== false,
      startingPrices: normalizeStartingPricesRows(Array.isArray(startingPrices) ? startingPrices : []),
      isFeatured: isFeatured || false,
      isSponsored: isSponsored || false,
      sponsoredImages: normalizeSponsoredImages(sponsoredImages),
      lockedTime: lockedTime && lockedTime.trim() !== '' ? new Date(lockedTime) : undefined,
      // Polls are option-based only (no default YES/NO poll)
      optionType: 'options',
    };

    // Handle option-based polls
    if (options && Array.isArray(options) && options.length > 0) {
      pollData.options = options.map((opt) => ({
        text: String(opt?.text || '').trim(),
        image: opt?.image || undefined,
        // Store summed liquidity for backward compatibility (resolution code paths, etc.)
        liquidity: (parseFloat(opt?.yesLiquidity) || 0) + (parseFloat(opt?.noLiquidity) || 0),
        shares: 0,
      }));

      const seed = options
        .map((opt) => ({
          optionKey: String(opt?.text || '').trim(),
          yes: parseFloat(opt?.yesLiquidity) || 0,
          no: parseFloat(opt?.noLiquidity) || 0,
        }))
        .filter((r) => r.optionKey && (r.yes > 0 || r.no > 0));

      const totalLiquidity = seed.reduce((sum, r) => sum + (r.yes || 0) + (r.no || 0), 0);
      pollData.marketInitialized = marketInitialized !== undefined ? marketInitialized : totalLiquidity > 0;
      pollData.orderbook = pollData.orderbook || {};
      pollData.orderbook.liquidityYesNo = seed;
    } else {
      // Legacy: allow creation without options, but keep API safe.
      pollData.options = [];
      pollData.marketYesLiquidity = marketYesLiquidity || 0;
      pollData.marketNoLiquidity = marketNoLiquidity || 0;
      pollData.marketInitialized = marketInitialized !== undefined ? marketInitialized : (marketYesLiquidity > 0 || marketNoLiquidity > 0);
    }

    const poll = new Poll(pollData);

    await poll.save();
    
    // Update cup active polls count
    cupDoc.activePolls = await Poll.countDocuments({ cup: cupDoc._id, status: 'active' });
    await cupDoc.save();

    if (poll.marketId) {
      scheduleMarketMakerSeed({ kind: 'poll', id: poll._id });
    }

    res.status(201).json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Poll
router.put('/polls/:id', async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.sponsoredImages !== undefined) {
      updates.sponsoredImages = normalizeSponsoredImages(updates.sponsoredImages);
    }
    if (updates.date !== undefined) {
      updates.date =
        updates.date && String(updates.date).trim() !== '' ? new Date(updates.date) : null;
    }
    const poll = await Poll.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }
    if (poll.marketId) {
      scheduleMarketMakerSeed({ kind: 'poll', id: poll._id });
    }
    res.json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Poll Status
router.post('/polls/:id/status', async (req, res) => {
  try {
    const { status, lockedTime } = req.body;
    const update = { status };
    if (lockedTime !== undefined) {
      update.lockedTime = lockedTime ? new Date(lockedTime) : null;
    }
    const poll = await Poll.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }
    res.json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add liquidity to poll market
router.post('/polls/:id/liquidity', async (req, res) => {
  try {
    const { yesLiquidity, noLiquidity, optionIndex, optionLiquidity, optionYes, optionNo, options } = req.body;
    const poll = await Poll.findById(req.params.id);
    
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }
    
    // Handle option-based polls
    if (poll.optionType === 'options') {
      // New shape from frontend: options is an array of { text, liquidity }
      if (Array.isArray(options) && options.length > 0) {
        if (!poll.options || poll.options.length === 0) {
          return res.status(400).json({ message: 'Poll has no options configured' });
        }
        options.forEach((opt, idx) => {
          const amount = opt && typeof opt.liquidity === 'number' ? opt.liquidity : 0;
          if (amount > 0 && poll.options[idx]) {
            poll.options[idx].liquidity = (poll.options[idx].liquidity || 0) + amount;
          }
        });
        poll.marketInitialized = true;
      } else if (
        optionIndex !== undefined &&
        (optionLiquidity !== undefined || optionYes !== undefined || optionNo !== undefined)
      ) {
        if (!poll.options || !poll.options[optionIndex]) {
          return res.status(400).json({ message: 'Invalid option index' });
        }
        const y = parseFloat(optionYes) || 0;
        const n = parseFloat(optionNo) || 0;
        const legacy = parseFloat(optionLiquidity) || 0;
        const addSum = y + n + legacy;
        if (addSum > 0) {
          poll.options[optionIndex].liquidity = (poll.options[optionIndex].liquidity || 0) + addSum;
        }
        poll.orderbook = poll.orderbook || {};
        const list = Array.isArray(poll.orderbook.liquidityYesNo) ? [...poll.orderbook.liquidityYesNo] : [];
        const text = String(poll.options[optionIndex].text || '').trim();
        if (text && (y > 0 || n > 0)) {
          const ix = list.findIndex((x) => x.optionKey === text);
          if (ix >= 0) {
            list[ix].yes = (list[ix].yes || 0) + y;
            list[ix].no = (list[ix].no || 0) + n;
          } else {
            list.push({ optionKey: text, yes: y, no: n });
          }
        }
        poll.orderbook.liquidityYesNo = list;
        poll.marketInitialized = true;
      } else {
        return res.status(400).json({ message: 'No liquidity data provided for option-based poll' });
      }
    } else {
      // Normal Yes/No poll
      poll.marketYesLiquidity = (poll.marketYesLiquidity || 0) + (yesLiquidity || 0);
      poll.marketNoLiquidity = (poll.marketNoLiquidity || 0) + (noLiquidity || 0);
      poll.marketInitialized = true;
    }
    
    await poll.save();
    if (poll.marketId) {
      scheduleMarketMakerSeed({ kind: 'poll', id: poll._id });
    }
    res.json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete Poll
router.delete('/polls/:id', async (req, res) => {
  try {
    const poll = await Poll.findByIdAndDelete(req.params.id);
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }
    res.json({ message: 'Poll deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Resolve Poll
router.post('/polls/:id/resolve', async (req, res) => {
  try {
    const { result, optionIndex, reResolve } = req.body;
    
    const poll = await Poll.findById(req.params.id);
    
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }

    const wasAlreadyResolved = poll.isResolved === true;
    const isReResolve = wasAlreadyResolved || reResolve === true;

    if (isReResolve && wasAlreadyResolved) {
      const existing = await Prediction.find({ poll: poll._id });
      const reverseFreeByUser = new Map();
      const bulkOps = [];
      for (const prediction of existing) {
        if (prediction.type === 'free' && (prediction.jackpotPayout || 0) > 0) {
          const uid = prediction.user.toString();
          reverseFreeByUser.set(uid, (reverseFreeByUser.get(uid) || 0) + prediction.jackpotPayout);
        }
        if (prediction.type === 'boost' || prediction.type === 'free' || prediction.type === 'market') {
          const $set = {
            status: 'pending',
            payout: 0,
            claimed: false,
            jackpotPayout: 0,
            jackpotClaimed: false,
            jackpotClaimInProgress: false,
            claimInProgress: false,
          };
          if (prediction.type === 'boost' && (prediction.originalStake || 0) > 0) {
            $set.totalStake = prediction.originalStake;
            $set.amount = prediction.originalStake;
          }
          bulkOps.push({ updateOne: { filter: { _id: prediction._id }, update: { $set } } });
        }
      }
      if (bulkOps.length) {
        await Prediction.bulkWrite(bulkOps, { ordered: false });
      }
      for (const [uid, amt] of reverseFreeByUser.entries()) {
        await User.updateOne({ _id: uid }, { $inc: { jackpotBalance: -amt, jackpotWins: -1 } });
        await User.updateOne({ _id: uid, jackpotBalance: { $lt: 0 } }, { $set: { jackpotBalance: 0 } });
        await User.updateOne({ _id: uid, jackpotWins: { $lt: 0 } }, { $set: { jackpotWins: 0 } });
      }
      poll.freeJackpotPool = (poll.originalFreeJackpotPool || 0) + (poll.freeJackpotPool || 0);
    }

    let normalizedResult = '';
    let winningOptionText = '';
    
    // Handle option-based polls
    if (poll.optionType === 'options' && optionIndex !== undefined) {
      if (!poll.options || !poll.options[optionIndex]) {
        return res.status(400).json({ message: 'Invalid option index' });
      }
      // The selected option becomes "YES", others become "NO"
      normalizedResult = 'YES';
      winningOptionText = poll.options[optionIndex].text;
      poll.result = winningOptionText; // Store the winning option text
    } else {
      // Normal Yes/No poll
      if (!['yes', 'no', 'YES', 'NO', 'Yes', 'No'].includes(result)) {
        return res.status(400).json({ message: 'Invalid result. Must be YES or NO' });
      }
      normalizedResult = result.toUpperCase();
      poll.result = normalizedResult;
    }
    
    // Calculate total liquidity from all options
    let totalMarketLiquidity = 0;
    const totalBoostPool = poll.boostPool || 0;
    
    if (poll.optionType === 'options') {
      // For option-based polls, calculate total from all options
      totalMarketLiquidity = poll.options.reduce((sum, opt) => sum + (opt.liquidity || 0), 0);
      
      // Move all liquidity to winning option
      poll.options.forEach((opt, idx) => {
        if (idx === optionIndex) {
          opt.liquidity = totalMarketLiquidity;
        } else {
          opt.liquidity = 0;
        }
      });
    } else {
      // Normal Yes/No poll
      totalMarketLiquidity = (poll.marketYesLiquidity || 0) + (poll.marketNoLiquidity || 0);
      
      // Move all liquidity to winning option
      if (normalizedResult === 'YES') {
        poll.marketYesLiquidity = totalMarketLiquidity;
        poll.marketNoLiquidity = 0;
      } else {
        poll.marketNoLiquidity = totalMarketLiquidity;
        poll.marketYesLiquidity = 0;
      }
    }
    
    poll.status = 'settled';
    poll.isResolved = true;
    await poll.save();

    // Update all prediction types
    const predictions = await Prediction.find({ poll: poll._id });
    const boostPredictions = [];
    const marketWinningPredictions = [];
    const predictionBulkOps = [];
    
    // First pass: determine win/loss status and collect predictions
    for (const prediction of predictions) {
      let isWinner = false;
      
      if (poll.optionType === 'options') {
        // For option-based polls, check if prediction outcome matches the selected option
        // Trim and compare to handle any whitespace issues
        isWinner = (prediction.outcome || '').trim() === (winningOptionText || '').trim();
      } else {
        // Normal Yes/No poll - normalize both sides for comparison
        // Handle various formats: "YES", "yes", "Yes", "NO", "no", "No"
        const predictionOutcome = (prediction.outcome || '').trim();
        const normalizedOutcome = predictionOutcome.toUpperCase();
        const normalizedResultUpper = (normalizedResult || '').toUpperCase().trim();
        
        // Also check if prediction outcome matches result directly (case-insensitive)
        isWinner = normalizedOutcome === normalizedResultUpper || 
                   predictionOutcome.toLowerCase() === normalizedResult.toLowerCase();
      }
      
      if (isWinner) {
        prediction.status = 'won';
      } else {
        prediction.status = 'lost';
        // For losing market predictions, set shares to 0 (only on first resolve)
        if (prediction.type === 'market' && !wasAlreadyResolved) {
          prediction.shares = 0;
        }
        // Note: Don't zero out boost losing stakes yet - we need them for payout calculation
      }
      
      // For market predictions, collect winners for proportional distribution
      if (prediction.type === 'market') {
        if (prediction.status === 'won') {
          marketWinningPredictions.push(prediction);
        } else {
          // Losing predictions get 0 payout
          prediction.payout = 0;
          prediction.status = 'settled';
        }
      }
      
      if (prediction.type === 'boost') {
        boostPredictions.push(prediction);
      }

      if (prediction.type === 'free') {
        predictionBulkOps.push({
          updateOne: {
            filter: { _id: prediction._id },
            update: { $set: { status: prediction.status } },
          },
        });
      } else if (prediction.type === 'market' && prediction.status !== 'won') {
        predictionBulkOps.push({
          updateOne: {
            filter: { _id: prediction._id },
            update: {
              $set: {
                payout: prediction.payout,
                status: prediction.status,
                shares: prediction.shares,
              },
            },
          },
        });
      }
    }

    if (predictionBulkOps.length > 0) {
      await Prediction.bulkWrite(predictionBulkOps, { ordered: false });
    }

    // Winning market shares pay $1 USDC each at resolution
    if (marketWinningPredictions.length > 0) {
      await Prediction.bulkWrite(
        marketWinningPredictions.map((prediction) => {
          const shares = Number(prediction.shares) || 0;
          const payout = shares > 0 ? Math.round(shares * 100) / 100 : 0;
          prediction.payout = payout;
          prediction.status = 'settled';
          return {
            updateOne: {
              filter: { _id: prediction._id },
              update: { $set: { payout, status: 'settled' } },
            },
          };
        }),
        { ordered: false }
      );
    }

    const winKey = poll.optionType === 'options' ? winningOptionText : normalizedResult;
    deferOrderbookResolutionPredictions({
      item: poll,
      kind: 'poll',
      winningOptionKey: winKey,
      totalMarketLiquidity,
    });

    // Boost: winners split the full boostPool by stake. Runs on first resolve AND on a result change.
    poll.originalBoostPool = poll.boostPool || 0;
    if (boostPredictions.length > 0) {
      const { applyBoostPoolPayouts } = require('../utils/boostPayout');
      applyBoostPoolPayouts({ boostPool: poll.boostPool, boostPredictions });
      await Prediction.bulkWrite(
        boostPredictions.map((p) => ({
          updateOne: {
            filter: { _id: p._id },
            update: {
              $set: {
                payout: p.payout,
                status: p.status,
                originalStake: p.originalStake,
                amount: p.amount,
                totalStake: p.totalStake,
              },
            },
          },
        })),
        { ordered: false }
      );
    }

    // Free jackpot: distribute by tickets. Runs on first resolve AND on a result change
    // (pool reconstituted + previous distribution reversed above for re-resolve).
    poll.originalFreeJackpotPool = poll.freeJackpotPool || 0;
    {
      const freeJackpotPoolAmount = poll.freeJackpotPool || 0;
      const freeWinningPredictions = predictions.filter((p) => p.type === 'free' && p.status === 'won');
      if (freeWinningPredictions.length > 0 && freeJackpotPoolAmount > 0) {
        let totalTickets = 0;
        for (const p of freeWinningPredictions) {
          totalTickets += Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
        }
        const perTicket = totalTickets > 0 ? freeJackpotPoolAmount / totalTickets : 0;
        const perUser = new Map();
        const jackpotBulkOps = [];
        for (const p of freeWinningPredictions) {
          const t = Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
          const amt = perTicket * t;
          p.jackpotPayout = amt;
          jackpotBulkOps.push({
            updateOne: {
              filter: { _id: p._id },
              update: { $set: { jackpotPayout: amt } },
            },
          });
          const uid = p.user.toString();
          perUser.set(uid, (perUser.get(uid) || 0) + amt);
        }
        if (jackpotBulkOps.length) {
          await Prediction.bulkWrite(jackpotBulkOps, { ordered: false });
        }
        const userJackpotOps = [];
        for (const [userId, amount] of perUser.entries()) {
          if (amount > 0) {
            userJackpotOps.push({
              updateOne: {
                filter: { _id: userId },
                update: { $inc: { jackpotBalance: amount, jackpotWins: 1 } },
              },
            });
          }
        }
        if (userJackpotOps.length) {
          await User.bulkWrite(userJackpotOps, { ordered: false });
          deferJackpotOnChainSync([...perUser.keys()]);
        }
        poll.freeJackpotPool = 0;
      }
    }

    // Award points (first resolve only — avoid inflation on re-resolve)
    if (!wasAlreadyResolved) {
    const freeWinningPredictionsForPoints = predictions.filter(p => p.type === 'free' && p.status === 'won');
    if (freeWinningPredictionsForPoints.length > 0) {
      const pointsPerWinSetting = await Settings.findOne({ key: 'pointsPerWin' });
      const pointsPerWin = pointsPerWinSetting ? (typeof pointsPerWinSetting.value === 'number' ? pointsPerWinSetting.value : parseFloat(pointsPerWinSetting.value) || 10) : 10;
      
      const pointsByUser = new Map();
      for (const p of freeWinningPredictionsForPoints) {
        const uid = p.user.toString();
        pointsByUser.set(uid, (pointsByUser.get(uid) || 0) + pointsPerWin);
      }
      const pointsOps = [...pointsByUser.entries()].map(([userId, pts]) => ({
        updateOne: {
          filter: { _id: userId },
          update: { $inc: { points: pts } },
        },
      }));
      if (pointsOps.length) {
        await User.bulkWrite(pointsOps, { ordered: false });
      }
    }
    }
    
    await poll.save();

    // Build claimable (boost + market separate) and jackpot updates for frontend to set on blockchain
    const predsForClaimPoll = await Prediction.find({
      poll: poll._id,
      type: { $in: ['boost', 'market'] },
      status: 'settled',
      payout: { $gt: 0 },
    }).lean();
    const claimUserIdsPoll = predsForClaimPoll.map((p) => p.user).filter(Boolean);
    const usersByIdPoll = await loadUsersWalletMap(claimUserIdsPoll);
    const {
      claimableUpdates,
      claimableBoostUpdates,
      claimableMarketUpdates,
    } = buildClaimableWalletPayloads(predsForClaimPoll, usersByIdPoll);
    const jackpotUserIdsPoll = [...new Set(
      predictions
        .filter((p) => (p.type === 'free' || p.type === 'boost') && p.status === 'won')
        .map((p) => p.user?.toString())
        .filter(Boolean)
    )];
    const jackpotUsersByIdPoll = await loadUsersWalletMap(jackpotUserIdsPoll);
    const jackpotUpdates = [];
    for (const uid of jackpotUserIdsPoll) {
      const user = jackpotUsersByIdPoll.get(uid);
      if (user?.walletAddress && (user.jackpotBalance || 0) > 0) {
        jackpotUpdates.push({ walletAddress: user.walletAddress, amount: user.jackpotBalance });
      }
    }

    res.json({ poll, claimableUpdates, claimableBoostUpdates, claimableMarketUpdates, jackpotUpdates });

    if (!wasAlreadyResolved) {
      deferOrderbookFinalize(poll);
    }
  } catch (error) {
    console.error('resolve poll:', error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || 'Resolve failed' });
    }
  }
});

// Create Cup
router.post('/cups', async (req, res) => {
  try {
    const cup = new Cup(req.body);
    await cup.save();
    res.status(201).json(cup);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Cup
router.put('/cups/:id', async (req, res) => {
  try {
    const cup = await Cup.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }
    res.json(cup);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete Cup
router.delete('/cups/:id', async (req, res) => {
  try {
    const cup = await Cup.findByIdAndDelete(req.params.id);
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }
    res.json({ message: 'Cup deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update navbar order for cups (bulk update)
router.post('/cups/navbar-order', async (req, res) => {
  try {
    const { cupOrders } = req.body; // Array of { cupId, navbarOrder }
    
    const updatePromises = cupOrders.map(({ cupId, navbarOrder }) =>
      Cup.findByIdAndUpdate(cupId, { navbarOrder }, { new: true })
    );
    
    await Promise.all(updatePromises);
    res.json({ message: 'Navbar order updated successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create Stage
router.post('/stages', async (req, res) => {
  try {
    const { name, cup, order, startDate, endDate, isCurrent } = req.body;

    const cupDoc = typeof cup === 'string' ? await Cup.findById(cup) : await Cup.findOne({ slug: cup });
    if (!cupDoc) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    const stage = new Stage({
      name,
      cup: cupDoc._id,
      order: order || 0,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      isCurrent: !!isCurrent,
    });

    await stage.save();
    res.status(201).json(stage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Match Status
router.post('/matches/:id/status', async (req, res) => {
  try {
    const { status, lockedTime } = req.body;
    const update = { status };
    if (lockedTime !== undefined) {
      update.lockedTime = lockedTime ? new Date(lockedTime) : null;
    }
    const match = await Match.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Set a stage as current for its cup (only one current per cup)
router.post('/stages/:id/set-current', async (req, res) => {
  try {
    const stage = await Stage.findById(req.params.id);
    if (!stage) {
      return res.status(404).json({ message: 'Stage not found' });
    }

    // Unset any other current stages for the same cup
    await Stage.updateMany(
      { cup: stage.cup, _id: { $ne: stage._id } },
      { $set: { isCurrent: false } }
    );

    stage.isCurrent = true;
    await stage.save();

    res.json(stage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Social Media Links Management
router.get('/settings/social-links/all', async (req, res) => {
  try {
    const socialKeys = ['socialTwitter', 'socialFacebook', 'socialInstagram', 'socialYoutube'];
    const socialLinks = {};
    
    for (const key of socialKeys) {
      const setting = await Settings.findOne({ key });
      socialLinks[key] = setting ? setting.value : '';
    }
    
    res.json(socialLinks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/social-links', async (req, res) => {
  try {
    const { socialTwitter, socialFacebook, socialInstagram, socialYoutube } = req.body;
    
    // Accept any string value - no strict validation, allow any link format
    const socialLinks = {
      socialTwitter: socialTwitter ? String(socialTwitter).trim() : '',
      socialFacebook: socialFacebook ? String(socialFacebook).trim() : '',
      socialInstagram: socialInstagram ? String(socialInstagram).trim() : '',
      socialYoutube: socialYoutube ? String(socialYoutube).trim() : '',
    };
    
    // Use upsert to update or create settings - no strict validation
    for (const [key, value] of Object.entries(socialLinks)) {
      await Settings.findOneAndUpdate(
        { key },
        {
          key,
          value: value || '', // Allow empty strings
          description: `Social media link for ${key.replace('social', '')}`,
          updatedAt: new Date(),
        },
        { upsert: true, new: true, runValidators: false } // Disable validators to allow any value
      );
    }
    
    res.json({ message: 'Social links updated successfully', socialLinks });
  } catch (error) {
    console.error('Error updating social links:', error);
    res.status(500).json({ 
      message: error.message || 'Failed to update social links',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// --- Ticket / NFT / golden ticket settings (MUST be before /settings/:key) ---
router.get('/settings/dailyFreeTickets', async (req, res) => {
  try {
    const s = await Settings.findOne({ key: 'dailyFreeTickets' }) || await Settings.findOne({ key: 'dailyFreePlayLimit' });
    res.json({ value: s?.value ?? 1 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/dailyFreeTickets', async (req, res) => {
  try {
    const value = Math.max(0, parseInt(req.body.value, 10) || 0);
    await Settings.findOneAndUpdate(
      { key: 'dailyFreeTickets' },
      { key: 'dailyFreeTickets', value, description: 'Daily normal tickets per user (resets, no accumulate)' },
      { upsert: true, new: true }
    );
    await Settings.findOneAndUpdate({ key: 'dailyFreePlayLimit' }, { value }, { upsert: true });
    res.json({ value });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/settings/nftTicketBonuses', async (req, res) => {
  try {
    const s = await Settings.findOne({ key: 'nftTicketBonuses' }).lean();
    const raw = s?.value;
    const list = Array.isArray(raw) ? raw : [];
    res.json({ list });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/nftTicketBonuses', async (req, res) => {
  try {
    const list = Array.isArray(req.body.list) ? req.body.list : [];
    await Settings.findOneAndUpdate(
      { key: 'nftTicketBonuses' },
      { key: 'nftTicketBonuses', value: list, description: 'NFT holder daily ticket bonuses' },
      { upsert: true, new: true }
    );
    res.json({ list });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/settings/goldenTicketBoostRanges', async (req, res) => {
  try {
    const s = await Settings.findOne({ key: 'goldenTicketBoostRanges' }).lean();
    const raw = s?.value;
    const ranges = Array.isArray(raw) ? raw : [];
    res.json({ ranges });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/goldenTicketBoostRanges', async (req, res) => {
  try {
    const ranges = Array.isArray(req.body.ranges) ? req.body.ranges : [];
    await Settings.findOneAndUpdate(
      { key: 'goldenTicketBoostRanges' },
      { key: 'goldenTicketBoostRanges', value: ranges, description: 'USDC stake ranges → golden tickets earned' },
      { upsert: true, new: true }
    );
    res.json({ ranges });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/settings/goldenTicketBoostRate', async (req, res) => {
  try {
    const { getGoldenTicketBoostRate } = require('../services/ticketService');
    const rate = await getGoldenTicketBoostRate();
    res.json({ rate });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/goldenTicketBoostRate', async (req, res) => {
  try {
    const tickets = Math.max(0, parseInt(req.body.tickets, 10) || 1);
    const perUsdc = Math.max(0.01, Number(req.body.perUsdc) || 10);
    const rate = { tickets, perUsdc };
    await Settings.findOneAndUpdate(
      { key: 'goldenTicketBoostRate' },
      {
        key: 'goldenTicketBoostRate',
        value: rate,
        description: 'Golden tickets earned per USDC staked on boost (rounded to nearest whole)',
      },
      { upsert: true, new: true }
    );
    res.json({ rate });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/settings/referralRewards', async (req, res) => {
  try {
    const { getReferralRewardSettings } = require('../services/referralService');
    const settings = await getReferralRewardSettings();
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/referralRewards', async (req, res) => {
  try {
    const { setReferralRewardSettings } = require('../services/referralService');
    const settings = await setReferralRewardSettings({
      enabled: req.body.enabled,
      goldenTicketsPerReferral: req.body.goldenTicketsPerReferral,
    });
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Settings Management (generic key — register AFTER specific /settings/* routes)
router.get('/settings/:key', async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: req.params.key });
    if (!setting) {
      // Return default value
      const defaults = {
        dailyFreePlayLimit: 1,
        pointsPerWin: 10,
      };
      return res.json({ key: req.params.key, value: defaults[req.params.key] || null });
    }
    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/settings/:key', async (req, res) => {
  try {
    const { value } = req.body;
    let setting = await Settings.findOne({ key: req.params.key });
    
    const descriptions = {
      dailyFreePlayLimit: 'Number of free predictions per day',
      pointsPerWin: 'Points awarded per winning prediction',
    };
    
    if (setting) {
      setting.value = value;
      if (descriptions[req.params.key]) {
        setting.description = descriptions[req.params.key];
      }
      await setting.save();
    } else {
      setting = new Settings({
        key: req.params.key,
        value,
        description: descriptions[req.params.key] || '',
      });
      await setting.save();
    }
    
    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Legacy helper — use applyBoostPoolPayouts from utils/boostPayout.js (same as resolve flow).
async function calculateBoostPayouts(matchId, pollId) {
  const predictions = await Prediction.find({
    ...(matchId ? { match: matchId } : { poll: pollId }),
    type: 'boost',
    status: 'won',
  });
  if (!predictions.length) return;
  const match = matchId ? await Match.findById(matchId) : null;
  const poll = pollId ? await Poll.findById(pollId) : null;
  const pool = match?.boostPool || poll?.boostPool || 0;
  const { applyBoostPoolPayouts } = require('../utils/boostPayout');
  applyBoostPoolPayouts({ boostPool: pool, boostPredictions: predictions });
  for (const p of predictions) await p.save();
}

router.get('/users', async (req, res) => {
  try {
    const { listUsersForAdmin } = require('../services/userBanService');
    const data = await listUsersForAdmin({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/users/ban', async (req, res) => {
  try {
    const { resolveUserForBan, banUserById } = require('../services/userBanService');
    const { userId, username, email, walletAddress, identifier, reason } = req.body;
    const user = await resolveUserForBan({ userId, username, email, walletAddress, identifier });
    if (!user) return res.status(404).json({ message: 'User not found' });
    const result = await banUserById(user._id, { reason, bannedBy: req.user._id });
    res.json({
      message: result.alreadyBanned ? 'User was already banned' : 'User banned',
      user: {
        id: result.user._id,
        username: result.user.username,
        banned: true,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

router.post('/users/unban', async (req, res) => {
  try {
    const { unbanUserById } = require('../services/userBanService');
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'userId is required' });
    const user = await unbanUserById(userId);
    res.json({
      message: 'User unbanned',
      user: { id: user._id, username: user.username, banned: false },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

router.post('/users/gift-golden-tickets', async (req, res) => {
  try {
    const { email, walletAddress, identifier, quantity, amount } = req.body;
    const qty = Math.max(0, parseInt(quantity ?? amount, 10) || 0);
    if (qty <= 0) return res.status(400).json({ message: 'quantity required' });
    const user = await resolveUserByIdentifier({ email, walletAddress, identifier });
    if (!user) return res.status(404).json({ message: 'User not found' });
    await awardGoldenTickets(user._id, qty);
    const updated = await User.findById(user._id).select('goldenTickets email username');
    res.json({
      message: 'Golden tickets gifted',
      userId: user._id,
      goldenTickets: updated?.goldenTickets ?? 0,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.post('/users/golden-ticket-daily-grant', async (req, res) => {
  try {
    const { email, walletAddress, identifier, ticketsPerDay, days } = req.body;
    const result = await createDailyGoldenTicketGrant({
      email,
      walletAddress,
      identifier,
      ticketsPerDay,
      days,
      createdBy: req.user._id,
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.get('/users/golden-ticket-daily-grants', async (req, res) => {
  try {
    const grants = await listActiveGrants(100);
    res.json({ grants });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.delete('/users/golden-ticket-daily-grants/:id', async (req, res) => {
  try {
    const grant = await cancelGrant(req.params.id);
    res.json({ message: 'Daily grant schedule cancelled', grant });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

async function adjustPoolField(Model, id, field, action, amount, options = {}) {
  const doc = await Model.findById(id);
  if (!doc) {
    const e = new Error('Not found');
    e.statusCode = 404;
    throw e;
  }
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    const e = new Error('Invalid amount');
    e.statusCode = 400;
    throw e;
  }
  const cur = doc[field] || 0;
  if ((action === 'withdraw' || action === 'subtract') && cur < amt) {
    const e = new Error('Insufficient pool balance');
    e.statusCode = 400;
    throw e;
  }
  doc[field] = action === 'add' ? cur + amt : cur - amt;
  await doc.save();

  // After resolution, auto-distribute admin top-ups to current winners.
  if (doc.isResolved && action === 'add' && amt > 0) {
    const kind = options.kind || (Model.modelName === 'Match' ? 'match' : 'poll');
    if (field === 'freeJackpotPool') {
      await distributeFreeJackpotTopUp({ item: doc, kind, amount: amt });
    } else if (field === 'boostPool') {
      await distributeBoostPoolTopUp({ item: doc, kind, amount: amt });
    }
  }

  return doc;
}

router.get('/matches-list', async (req, res) => {
  try {
    const matches = await Match.find().sort({ date: -1 }).lean();
    const ticketMap = await getTicketTotalsByEvent(matches.map((m) => m._id), 'match');
    res.json(
      matches.map((m) => {
        const pools = displayJackpotPools(m);
        return {
          ...m,
          totalFreeTickets: ticketMap.get(String(m._id)) || 0,
          displayFreeJackpot: pools.freeJackpot,
          displayBoostJackpot: pools.boostJackpot,
        };
      })
    );
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/polls-list', async (req, res) => {
  try {
    const polls = await Poll.find().sort({ createdAt: -1 }).lean();
    const ticketMap = await getTicketTotalsByEvent(polls.map((p) => p._id), 'poll');
    res.json(
      polls.map((p) => {
        const pools = displayJackpotPools(p);
        return {
          ...p,
          totalFreeTickets: ticketMap.get(String(p._id)) || 0,
          displayFreeJackpot: pools.freeJackpot,
          displayBoostJackpot: pools.boostJackpot,
        };
      })
    );
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/matches/:id/jackpot-pool', async (req, res) => {
  const m = await Match.findById(req.params.id).select('freeJackpotPool originalFreeJackpotPool teamA teamB');
  if (!m) return res.status(404).json({ message: 'Not found' });
  res.json({ pool: m.freeJackpotPool || 0, original: m.originalFreeJackpotPool || 0, label: `${m.teamA} vs ${m.teamB}` });
});

router.post('/matches/:id/jackpot-pool', async (req, res) => {
  try {
    const doc = await adjustPoolField(Match, req.params.id, 'freeJackpotPool', req.body.action, req.body.amount, { kind: 'match' });
    res.json({ freeJackpotPool: doc.freeJackpotPool, originalFreeJackpotPool: doc.originalFreeJackpotPool });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.get('/matches/:id/boost-pool', async (req, res) => {
  const m = await Match.findById(req.params.id).select('boostPool teamA teamB');
  if (!m) return res.status(404).json({ message: 'Not found' });
  res.json({ pool: m.boostPool || 0, label: `${m.teamA} vs ${m.teamB}` });
});

router.post('/matches/:id/boost-pool', async (req, res) => {
  try {
    const doc = await adjustPoolField(Match, req.params.id, 'boostPool', req.body.action, req.body.amount, { kind: 'match' });
    res.json({ boostPool: doc.boostPool, originalBoostPool: doc.originalBoostPool });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.get('/polls/:id/jackpot-pool', async (req, res) => {
  const p = await Poll.findById(req.params.id).select('freeJackpotPool originalFreeJackpotPool question');
  if (!p) return res.status(404).json({ message: 'Not found' });
  res.json({ pool: p.freeJackpotPool || 0, original: p.originalFreeJackpotPool || 0, label: p.question });
});

router.post('/polls/:id/jackpot-pool', async (req, res) => {
  try {
    const doc = await adjustPoolField(Poll, req.params.id, 'freeJackpotPool', req.body.action, req.body.amount, { kind: 'poll' });
    res.json({ freeJackpotPool: doc.freeJackpotPool, originalFreeJackpotPool: doc.originalFreeJackpotPool });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.get('/polls/:id/boost-pool', async (req, res) => {
  const p = await Poll.findById(req.params.id).select('boostPool question');
  if (!p) return res.status(404).json({ message: 'Not found' });
  res.json({ pool: p.boostPool || 0, label: p.question });
});

router.post('/polls/:id/boost-pool', async (req, res) => {
  try {
    const doc = await adjustPoolField(Poll, req.params.id, 'boostPool', req.body.action, req.body.amount, { kind: 'poll' });
    res.json({ boostPool: doc.boostPool, originalBoostPool: doc.originalBoostPool });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

// Newsletter subscribers
router.get('/newsletter', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const search = String(req.query.search || '').trim().toLowerCase();

    const filter = search ? { email: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};

    const [items, total] = await Promise.all([
      NewsletterSubscriber.find(filter).sort({ subscribedAt: -1 }).skip(skip).limit(limit).lean(),
      NewsletterSubscriber.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/newsletter/export', async (req, res) => {
  try {
    const subscribers = await NewsletterSubscriber.find().sort({ subscribedAt: -1 }).lean();
    const escapeCsv = (val) => {
      const s = String(val ?? '');
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = 'email,source,subscribedAt\n';
    const rows = subscribers
      .map((s) =>
        [
          escapeCsv(s.email),
          escapeCsv(s.source || ''),
          escapeCsv(s.subscribedAt ? new Date(s.subscribedAt).toISOString() : ''),
        ].join(',')
      )
      .join('\n');

    const filename = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + header + rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/newsletter/:id', async (req, res) => {
  try {
    const deleted = await NewsletterSubscriber.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: 'Subscriber not found' });
    }
    res.json({ message: 'Subscriber removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
