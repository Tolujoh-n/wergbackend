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
const { uploadImage, deleteImage } = require('../utils/cloudinary');

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
    const { teamA, teamB, date, cup, stage, stageName, marketId, marketTeamALiquidity, marketTeamBLiquidity, marketDrawLiquidity, isFeatured, isSponsored, sponsoredImages, lockedTime, teamAImage, teamBImage, marketInitialized } = req.body;

    const cupDoc = typeof cup === 'string' ? await Cup.findById(cup) : await Cup.findOne({ slug: cup });
    if (!cupDoc) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    let stageDoc = null;
    if (stage) {
      stageDoc = typeof stage === 'string' ? await Stage.findById(stage) : stage;
    }

    const match = new Match({
      teamA,
      teamB,
      date: new Date(date),
      cup: cupDoc._id,
      stage: stageDoc?._id,
      stageName: stageDoc?.name || stageName,
      marketId: marketId ? parseInt(marketId, 10) : undefined,
      marketTeamALiquidity: marketTeamALiquidity || 0,
      marketTeamBLiquidity: marketTeamBLiquidity || 0,
      marketDrawLiquidity: marketDrawLiquidity || 0,
      marketInitialized: marketInitialized !== undefined ? marketInitialized : (marketTeamALiquidity > 0 || marketTeamBLiquidity > 0 || marketDrawLiquidity > 0),
      isFeatured: isFeatured || false,
      isSponsored: isSponsored || false,
      sponsoredImages: Array.isArray(sponsoredImages) ? sponsoredImages.filter(img => img && img.trim() !== '') : [],
      lockedTime: lockedTime && lockedTime.trim() !== '' ? new Date(lockedTime) : undefined,
      teamAImage: teamAImage || undefined,
      teamBImage: teamBImage || undefined,
    });

    await match.save();
    
    // Update cup active matches count
    cupDoc.activeMatches = await Match.countDocuments({ cup: cupDoc._id, status: { $in: ['upcoming', 'live'] } });
    await cupDoc.save();

    res.status(201).json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Match
router.put('/matches/:id', async (req, res) => {
  try {
    const match = await Match.findByIdAndUpdate(req.params.id, req.body, {
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
    const { teamALiquidity, teamBLiquidity, drawLiquidity } = req.body;
    const match = await Match.findById(req.params.id);
    
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    match.marketTeamALiquidity += teamALiquidity || 0;
    match.marketTeamBLiquidity += teamBLiquidity || 0;
    match.marketDrawLiquidity += drawLiquidity || 0;
    match.marketInitialized = true;
    
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
    let { result } = req.body;
    
    const match = await Match.findById(req.params.id);
    
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
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
        // For losing market predictions, set shares to 0
        if (prediction.type === 'market') {
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
      
      // Save free predictions after status is set
      if (prediction.type === 'free') {
        await prediction.save();
      }
    }

    // Calculate market payouts: distribute total liquidity proportionally to winners
    if (marketWinningPredictions.length > 0) {
      const totalWinningShares = marketWinningPredictions.reduce((sum, p) => sum + (p.shares || 0), 0);
      if (totalWinningShares > 0) {
        for (const prediction of marketWinningPredictions) {
          prediction.payout = (prediction.shares / totalWinningShares) * totalMarketLiquidity;
          prediction.status = 'settled';
          await prediction.save();
        }
      }
    }

    // Calculate and update payouts for boost predictions
    // Winners get their stake back + proportional share of all losing stakes
    if (boostPredictions.length > 0) {
      // Store original stake values before any modifications
      const originalStakes = new Map();
      for (const prediction of boostPredictions) {
        originalStakes.set(prediction._id.toString(), prediction.totalStake || prediction.amount || 0);
      }
      
      const winningBoostPredictions = boostPredictions.filter(p => p.status === 'won');
      const losingBoostPredictions = boostPredictions.filter(p => p.status === 'lost');
      
      // Calculate total losing stakes using original values (these will be distributed to winners)
      const totalLosingStakes = losingBoostPredictions.reduce((sum, p) => {
        const originalStake = originalStakes.get(p._id.toString()) || 0;
        return sum + originalStake;
      }, 0);
      
      // Calculate total winning stakes using original values (for proportional distribution)
      const totalWinningStake = winningBoostPredictions.reduce((sum, p) => {
        const originalStake = originalStakes.get(p._id.toString()) || 0;
        return sum + originalStake;
      }, 0);

      if (totalWinningStake > 0) {
        // Distribute losing stakes proportionally to winners
        for (const prediction of boostPredictions) {
          const originalStake = originalStakes.get(prediction._id.toString()) || 0;
          // Store original stake before any modifications (for display after resolution)
          prediction.originalStake = originalStake;
          
          if (prediction.status === 'won') {
            // Calculate user's share of losing stakes based on their stake proportion
            const shareOfLosingStakes = totalLosingStakes > 0 
              ? (originalStake / totalWinningStake) * totalLosingStakes 
              : 0;
            // Payout = original stake + share of losing stakes
            prediction.payout = originalStake + shareOfLosingStakes;
          } else {
            // Losing predictions get 0 (their stake goes to winners)
            // But keep originalStake for display purposes
            prediction.payout = 0;
            prediction.amount = 0;
            prediction.totalStake = 0;
          }
          prediction.status = 'settled'; // Mark as settled
          await prediction.save();
        }
      } else {
        // If no winning stake, all predictions get 0
        for (const prediction of boostPredictions) {
          const originalStake = originalStakes.get(prediction._id.toString()) || 0;
          // Store original stake before zeroing (for display after resolution)
          prediction.originalStake = originalStake;
          prediction.payout = 0;
          prediction.amount = 0;
          prediction.totalStake = 0;
          prediction.status = 'settled';
          await prediction.save();
        }
      }
    }

    // Distribute jackpots to winners
    // Store original jackpot amounts before distribution (for display after resolution)
    match.originalFreeJackpotPool = match.freeJackpotPool || 0;
    match.originalBoostJackpotPool = match.boostJackpotPool || 0;
    
    // Free jackpot: distribute to winning free predictions
    const freeWinningPredictions = predictions.filter((p) => p.type === 'free' && p.status === 'won');
    const freeWinnerUserIds = [...new Set(freeWinningPredictions.map((p) => p.user.toString()))];
    if (freeWinnerUserIds.length > 0 && match.freeJackpotPool > 0) {
      const jackpotPerWinner = match.freeJackpotPool / freeWinnerUserIds.length;
      
      for (const userId of freeWinnerUserIds) {
        const user = await User.findById(userId);
        if (user) {
          user.jackpotBalance = (user.jackpotBalance || 0) + jackpotPerWinner;
          user.jackpotWins = (user.jackpotWins || 0) + 1;
          await user.save();
        }
      }
      // Reset jackpot pool after distribution (but keep original amount for display)
      match.freeJackpotPool = 0;
    }
    
    // Boost jackpot: distribute to winning boost predictions
    // Note: boost predictions are marked as 'settled' earlier, so we must use payout>0 (or original 'won') to identify winners
    const boostWinningPredictions = boostPredictions.filter(
      (p) => p.status === 'won' || (p.status === 'settled' && (p.payout || 0) > 0)
    );
    const boostWinnerUserIds = [...new Set(boostWinningPredictions.map((p) => p.user.toString()))];
    if (boostWinnerUserIds.length > 0 && match.boostJackpotPool > 0) {
      const jackpotPerWinner = match.boostJackpotPool / boostWinnerUserIds.length;
      
      for (const userId of boostWinnerUserIds) {
        const user = await User.findById(userId);
        if (user) {
          user.jackpotBalance = (user.jackpotBalance || 0) + jackpotPerWinner;
          user.jackpotWins = (user.jackpotWins || 0) + 1;
          await user.save();
        }
      }
      // Reset jackpot pool after distribution (but keep original amount for display)
      match.boostJackpotPool = 0;
    }
    
    // Award points to winning free predictions
    const freeWinningPredictionsForPoints = predictions.filter(p => p.type === 'free' && p.status === 'won');
    if (freeWinningPredictionsForPoints.length > 0) {
      const pointsPerWinSetting = await Settings.findOne({ key: 'pointsPerWin' });
      const pointsPerWin = pointsPerWinSetting ? (typeof pointsPerWinSetting.value === 'number' ? pointsPerWinSetting.value : parseFloat(pointsPerWinSetting.value) || 10) : 10;
      
      const userIds = [...new Set(freeWinningPredictionsForPoints.map(p => p.user.toString()))];
      for (const userId of userIds) {
        const user = await User.findById(userId);
        if (user) {
          const userWins = freeWinningPredictionsForPoints.filter(p => p.user.toString() === userId).length;
          user.points = (user.points || 0) + (userWins * pointsPerWin);
          await user.save();
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
    });
    const claimableByWallet = {};
    const claimableBoostByWallet = {};
    const claimableMarketByWallet = {};
    for (const p of predsForClaim) {
      const userId = p.user?._id ? p.user._id : p.user;
      if (!userId) continue;
      const user = await User.findById(userId).select('walletAddress').lean();
      const walletAddress = user?.walletAddress || (p.user?.walletAddress);
      if (!walletAddress || !walletAddress.trim()) continue;
      const w = walletAddress.trim();
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
    const predsWithUserForJackpot = await Prediction.find({ match: match._id }).populate('user', 'walletAddress jackpotBalance');
    const jackpotUserIds = [...new Set(
      predsWithUserForJackpot.filter(p => (p.type === 'free' || p.type === 'boost') && p.status === 'won').map(p => (p.user?._id || p.user)?.toString()).filter(Boolean)
    )];
    const jackpotUpdates = [];
    for (const uid of jackpotUserIds) {
      const user = await User.findById(uid).select('walletAddress jackpotBalance');
      if (user && user.walletAddress && user.jackpotBalance > 0) {
        jackpotUpdates.push({ walletAddress: user.walletAddress, amount: user.jackpotBalance });
      }
    }

    res.json({ match, claimableUpdates, claimableBoostUpdates, claimableMarketUpdates, jackpotUpdates });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create Poll with liquidity
router.post('/polls', async (req, res) => {
  try {
    const { question, description, thumbnailImage, type, cup, stage, marketId, marketYesLiquidity, marketNoLiquidity, isFeatured, isSponsored, sponsoredImages, lockedTime, optionType, options, marketInitialized } = req.body;

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
      marketId: marketId ? parseInt(marketId, 10) : undefined,
      isFeatured: isFeatured || false,
      isSponsored: isSponsored || false,
      sponsoredImages: Array.isArray(sponsoredImages) ? sponsoredImages.filter(img => img && img.trim() !== '') : [],
      lockedTime: lockedTime && lockedTime.trim() !== '' ? new Date(lockedTime) : undefined,
      optionType: optionType || 'normal',
    };

    // Handle option-based polls
    if (optionType === 'options' && options && Array.isArray(options) && options.length > 0) {
      pollData.options = options.map(opt => ({
        text: opt.text,
        image: opt.image || undefined,
        liquidity: opt.liquidity || 0,
        shares: 0,
      }));
      
      // Calculate total liquidity from options
      const totalLiquidity = options.reduce((sum, opt) => sum + (opt.liquidity || 0), 0);
      pollData.marketInitialized = marketInitialized !== undefined ? marketInitialized : (totalLiquidity > 0);
    } else {
      // Normal Yes/No poll
      pollData.marketYesLiquidity = marketYesLiquidity || 0;
      pollData.marketNoLiquidity = marketNoLiquidity || 0;
      pollData.marketInitialized = marketInitialized !== undefined ? marketInitialized : (marketYesLiquidity > 0 || marketNoLiquidity > 0);
    }

    const poll = new Poll(pollData);

    await poll.save();
    
    // Update cup active polls count
    cupDoc.activePolls = await Poll.countDocuments({ cup: cupDoc._id, status: 'active' });
    await cupDoc.save();

    res.status(201).json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Poll
router.put('/polls/:id', async (req, res) => {
  try {
    const poll = await Poll.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
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
    const { yesLiquidity, noLiquidity, optionIndex, optionLiquidity, options } = req.body;
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
      } else if (optionIndex !== undefined && optionLiquidity !== undefined) {
        // Backwards-compatible shape: single option index + liquidity
        if (!poll.options || !poll.options[optionIndex]) {
          return res.status(400).json({ message: 'Invalid option index' });
        }
        poll.options[optionIndex].liquidity = (poll.options[optionIndex].liquidity || 0) + (optionLiquidity || 0);
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
    const { result, optionIndex } = req.body;
    
    const poll = await Poll.findById(req.params.id);
    
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
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
        // For losing market predictions, set shares to 0
        if (prediction.type === 'market') {
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
      
      // Save free predictions after status is set
      if (prediction.type === 'free') {
        await prediction.save();
      }
    }

    // Calculate market payouts: distribute total liquidity proportionally to winners
    if (marketWinningPredictions.length > 0) {
      const totalWinningShares = marketWinningPredictions.reduce((sum, p) => sum + (p.shares || 0), 0);
      if (totalWinningShares > 0) {
        for (const prediction of marketWinningPredictions) {
          prediction.payout = (prediction.shares / totalWinningShares) * totalMarketLiquidity;
          prediction.status = 'settled';
          await prediction.save();
        }
      }
    }

    // Calculate and update payouts for boost predictions
    // Winners get their stake back + proportional share of all losing stakes
    if (boostPredictions.length > 0) {
      // Store original stake values before any modifications
      const originalStakes = new Map();
      for (const prediction of boostPredictions) {
        originalStakes.set(prediction._id.toString(), prediction.totalStake || prediction.amount || 0);
      }
      
      const winningBoostPredictions = boostPredictions.filter(p => p.status === 'won');
      const losingBoostPredictions = boostPredictions.filter(p => p.status === 'lost');
      
      // Calculate total losing stakes using original values (these will be distributed to winners)
      const totalLosingStakes = losingBoostPredictions.reduce((sum, p) => {
        const originalStake = originalStakes.get(p._id.toString()) || 0;
        return sum + originalStake;
      }, 0);
      
      // Calculate total winning stakes using original values (for proportional distribution)
      const totalWinningStake = winningBoostPredictions.reduce((sum, p) => {
        const originalStake = originalStakes.get(p._id.toString()) || 0;
        return sum + originalStake;
      }, 0);

      if (totalWinningStake > 0) {
        // Distribute losing stakes proportionally to winners
        for (const prediction of boostPredictions) {
          const originalStake = originalStakes.get(prediction._id.toString()) || 0;
          // Store original stake before any modifications (for display after resolution)
          prediction.originalStake = originalStake;
          
          if (prediction.status === 'won') {
            // Calculate user's share of losing stakes based on their stake proportion
            const shareOfLosingStakes = totalLosingStakes > 0 
              ? (originalStake / totalWinningStake) * totalLosingStakes 
              : 0;
            // Payout = original stake + share of losing stakes
            prediction.payout = originalStake + shareOfLosingStakes;
          } else {
            // Losing predictions get 0 (their stake goes to winners)
            // But keep originalStake for display purposes
            prediction.payout = 0;
            prediction.amount = 0;
            prediction.totalStake = 0;
          }
          prediction.status = 'settled'; // Mark as settled
          await prediction.save();
        }
      } else {
        // If no winning stake, all predictions get 0
        for (const prediction of boostPredictions) {
          const originalStake = originalStakes.get(prediction._id.toString()) || 0;
          // Store original stake before zeroing (for display after resolution)
          prediction.originalStake = originalStake;
          prediction.payout = 0;
          prediction.amount = 0;
          prediction.totalStake = 0;
          prediction.status = 'settled';
          await prediction.save();
        }
      }
    }

    // Store original jackpot amounts before distribution (for display after resolution)
    poll.originalFreeJackpotPool = poll.freeJackpotPool || 0;
    poll.originalBoostJackpotPool = poll.boostJackpotPool || 0;
    
    // Distribute jackpots to winners
    // Free jackpot: distribute to winning free predictions
    const freeWinningPredictions = predictions.filter((p) => p.type === 'free' && p.status === 'won');
    const freeWinnerUserIds = [...new Set(freeWinningPredictions.map((p) => p.user.toString()))];
    if (freeWinnerUserIds.length > 0 && poll.freeJackpotPool > 0) {
      const jackpotPerWinner = poll.freeJackpotPool / freeWinnerUserIds.length;
      
      for (const userId of freeWinnerUserIds) {
        const user = await User.findById(userId);
        if (user) {
          user.jackpotBalance = (user.jackpotBalance || 0) + jackpotPerWinner;
          user.jackpotWins = (user.jackpotWins || 0) + 1;
          await user.save();
        }
      }
      // Reset jackpot pool after distribution (but keep original amount for display)
      poll.freeJackpotPool = 0;
    }
    
    // Boost jackpot: distribute to winning boost predictions
    // Note: boost predictions are marked as 'settled' earlier, so we must use payout>0 (or original 'won') to identify winners
    const boostWinningPredictions = boostPredictions.filter(
      (p) => p.status === 'won' || (p.status === 'settled' && (p.payout || 0) > 0)
    );
    const boostWinnerUserIds = [...new Set(boostWinningPredictions.map((p) => p.user.toString()))];
    if (boostWinnerUserIds.length > 0 && poll.boostJackpotPool > 0) {
      const jackpotPerWinner = poll.boostJackpotPool / boostWinnerUserIds.length;
      
      for (const userId of boostWinnerUserIds) {
        const user = await User.findById(userId);
        if (user) {
          user.jackpotBalance = (user.jackpotBalance || 0) + jackpotPerWinner;
          user.jackpotWins = (user.jackpotWins || 0) + 1;
          await user.save();
        }
      }
      // Reset jackpot pool after distribution (but keep original amount for display)
      poll.boostJackpotPool = 0;
    }

    // Award points to winning free predictions
    const freeWinningPredictionsForPoints = predictions.filter(p => p.type === 'free' && p.status === 'won');
    if (freeWinningPredictionsForPoints.length > 0) {
      const pointsPerWinSetting = await Settings.findOne({ key: 'pointsPerWin' });
      const pointsPerWin = pointsPerWinSetting ? (typeof pointsPerWinSetting.value === 'number' ? pointsPerWinSetting.value : parseFloat(pointsPerWinSetting.value) || 10) : 10;
      
      const userIds = [...new Set(freeWinningPredictionsForPoints.map(p => p.user.toString()))];
      for (const userId of userIds) {
        const user = await User.findById(userId);
        if (user) {
          const userWins = freeWinningPredictionsForPoints.filter(p => p.user.toString() === userId).length;
          user.points = (user.points || 0) + (userWins * pointsPerWin);
          await user.save();
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
    });
    const claimableByWalletPoll = {};
    const claimableBoostByWalletPoll = {};
    const claimableMarketByWalletPoll = {};
    for (const p of predsForClaimPoll) {
      const userId = p.user?._id ? p.user._id : p.user;
      if (!userId) continue;
      const user = await User.findById(userId).select('walletAddress').lean();
      const walletAddress = user?.walletAddress || (p.user?.walletAddress);
      if (!walletAddress || !walletAddress.trim()) continue;
      const w = walletAddress.trim();
      const payout = p.payout || 0;
      claimableByWalletPoll[w] = (claimableByWalletPoll[w] || 0) + payout;
      if (p.type === 'boost') {
        claimableBoostByWalletPoll[w] = (claimableBoostByWalletPoll[w] || 0) + payout;
      } else {
        claimableMarketByWalletPoll[w] = (claimableMarketByWalletPoll[w] || 0) + payout;
      }
    }
    const claimableUpdates = Object.entries(claimableByWalletPoll).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    const claimableBoostUpdates = Object.entries(claimableBoostByWalletPoll).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    const claimableMarketUpdates = Object.entries(claimableMarketByWalletPoll).map(([walletAddress, amount]) => ({ walletAddress, amount }));
    const predsWithUserForJackpotPoll = await Prediction.find({ poll: poll._id }).populate('user', 'walletAddress jackpotBalance');
    const jackpotUserIds = [...new Set(
      predsWithUserForJackpotPoll.filter(p => (p.type === 'free' || p.type === 'boost') && p.status === 'won').map(p => (p.user?._id || p.user)?.toString()).filter(Boolean)
    )];
    const jackpotUpdates = [];
    for (const uid of jackpotUserIds) {
      const user = await User.findById(uid).select('walletAddress jackpotBalance');
      if (user && user.walletAddress && user.jackpotBalance > 0) {
        jackpotUpdates.push({ walletAddress: user.walletAddress, amount: user.jackpotBalance });
      }
    }

    res.json({ poll, claimableUpdates, claimableBoostUpdates, claimableMarketUpdates, jackpotUpdates });
  } catch (error) {
    res.status(500).json({ message: error.message });
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

// Settings Management (keep AFTER specific /settings/* routes to avoid route conflicts)
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

// Helper function to calculate boost payouts
async function calculateBoostPayouts(matchId, pollId) {
  const predictions = await Prediction.find({
    ...(matchId ? { match: matchId } : { poll: pollId }),
    type: 'boost',
    status: 'won',
  });

  if (predictions.length === 0) return;

  // Use totalStake if available, otherwise fall back to amount
  const totalWinningAmount = predictions.reduce((sum, p) => sum + (p.totalStake || p.amount || 0), 0);
  const match = matchId ? await Match.findById(matchId) : null;
  const poll = pollId ? await Poll.findById(pollId) : null;
  const pool = match?.boostPool || poll?.boostPool || 0;

  if (pool === 0 || totalWinningAmount === 0) return;

  // Calculate fees (10% platform, 10% jackpot)
  const platformFee = pool * 0.1;
  const jackpotFee = pool * 0.1;
  const distributablePool = pool - platformFee - jackpotFee;

  // Distribute proportionally based on stake
  for (const prediction of predictions) {
    const stake = prediction.totalStake || prediction.amount || 0;
    if (stake > 0) {
      const share = stake / totalWinningAmount;
      const reward = distributablePool * share;
      // Payout = original stake + reward (total claimable amount)
      prediction.payout = stake + reward;
      await prediction.save();
    }
  }
}

module.exports = router;
