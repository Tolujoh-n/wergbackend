const express = require('express');
const { auth, isAdmin } = require('../middleware/auth');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Cup = require('../models/Cup');
const Stage = require('../models/Stage');
const Prediction = require('../models/Prediction');
const User = require('../models/User');
const Blog = require('../models/Blog');
const Settings = require('../models/Settings');

const router = express.Router();

// All admin routes require authentication and admin role
router.use(auth);
router.use(isAdmin);

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

// Create Match with liquidity
router.post('/matches', async (req, res) => {
  try {
    const { teamA, teamB, date, cup, stage, stageName, marketTeamALiquidity, marketTeamBLiquidity, marketDrawLiquidity, isFeatured } = req.body;

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
      marketTeamALiquidity: marketTeamALiquidity || 0,
      marketTeamBLiquidity: marketTeamBLiquidity || 0,
      marketDrawLiquidity: marketDrawLiquidity || 0,
      marketInitialized: (marketTeamALiquidity > 0 || marketTeamBLiquidity > 0 || marketDrawLiquidity > 0),
      isFeatured: isFeatured || false,
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

    match.result = normalizedResult;
    match.status = 'completed';
    match.isResolved = true;
    await match.save();

    // Update all prediction types
    const predictions = await Prediction.find({ match: match._id });
    const boostPredictions = [];
    
    for (const prediction of predictions) {
      // Normalize outcome for comparison
      const normalizedOutcome = prediction.outcome.charAt(0).toUpperCase() + prediction.outcome.slice(1).toLowerCase();
      const normalizedPredictionOutcome = normalizedOutcome === 'Teama' ? 'TeamA' : (normalizedOutcome === 'Teamb' ? 'TeamB' : normalizedOutcome);
      
      if (normalizedPredictionOutcome === normalizedResult) {
        prediction.status = 'won';
      } else {
        prediction.status = 'lost';
      }
      
      // For market predictions, calculate payout based on shares
      if (prediction.type === 'market' && prediction.status === 'won') {
        // Market winners get payout based on their shares
        const totalShares = (match.marketTeamAShares || 0) + (match.marketTeamBShares || 0) + (match.marketDrawShares || 0);
        if (totalShares > 0) {
          const winningShares = normalizedResult === 'TeamA' ? (match.marketTeamAShares || 0) :
                               normalizedResult === 'TeamB' ? (match.marketTeamBShares || 0) :
                               (match.marketDrawShares || 0);
          const totalLiquidity = (match.marketTeamALiquidity || 0) + (match.marketTeamBLiquidity || 0) + (match.marketDrawLiquidity || 0);
          if (winningShares > 0 && prediction.shares > 0) {
            prediction.payout = (prediction.shares / winningShares) * totalLiquidity;
          }
        }
        prediction.status = 'settled';
      }
      
      if (prediction.type === 'boost') {
        boostPredictions.push(prediction);
      }
      
      await prediction.save();
    }

    // Calculate and update payouts for boost predictions
    if (boostPredictions.length > 0) {
      await calculateBoostPayouts(match._id);
    }

    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create Poll with liquidity
router.post('/polls', async (req, res) => {
  try {
    const { question, description, type, cup, stage, marketYesLiquidity, marketNoLiquidity, isFeatured } = req.body;

    const cupDoc = typeof cup === 'string' ? await Cup.findById(cup) : await Cup.findOne({ slug: cup });
    if (!cupDoc) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    let stageDoc = null;
    if (stage) {
      stageDoc = typeof stage === 'string' ? await Stage.findById(stage) : stage;
    }

    const poll = new Poll({
      question,
      description,
      type,
      cup: cupDoc._id,
      stage: stageDoc?._id,
      marketYesLiquidity: marketYesLiquidity || 0,
      marketNoLiquidity: marketNoLiquidity || 0,
      marketInitialized: (marketYesLiquidity > 0 || marketNoLiquidity > 0),
      isFeatured: isFeatured || false,
    });

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
    const { status } = req.body;
    const poll = await Poll.findByIdAndUpdate(req.params.id, { status }, { new: true });
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
    const { yesLiquidity, noLiquidity } = req.body;
    const poll = await Poll.findById(req.params.id);
    
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }

    poll.marketYesLiquidity += yesLiquidity || 0;
    poll.marketNoLiquidity += noLiquidity || 0;
    poll.marketInitialized = true;
    
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
    const { result } = req.body;
    
    // Validate result for poll (must be YES or NO)
    if (!['yes', 'no', 'YES', 'NO', 'Yes', 'No'].includes(result)) {
      return res.status(400).json({ message: 'Invalid result. Must be YES or NO' });
    }
    
    const poll = await Poll.findById(req.params.id);
    
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }

    const normalizedResult = result.toUpperCase();
    poll.result = normalizedResult;
    poll.status = 'settled';
    poll.isResolved = true;
    await poll.save();

    // Update all prediction types
    const predictions = await Prediction.find({ poll: poll._id });
    const boostPredictions = [];
    
    for (const prediction of predictions) {
      const normalizedOutcome = prediction.outcome.toUpperCase();
      
      if (normalizedOutcome === normalizedResult) {
        prediction.status = 'won';
      } else {
        prediction.status = 'lost';
      }
      
      // For market predictions, calculate payout based on shares
      if (prediction.type === 'market' && prediction.status === 'won') {
        const totalShares = (poll.marketYesShares || 0) + (poll.marketNoShares || 0);
        if (totalShares > 0) {
          const winningShares = normalizedResult === 'YES' ? (poll.marketYesShares || 0) : (poll.marketNoShares || 0);
          const totalLiquidity = (poll.marketYesLiquidity || 0) + (poll.marketNoLiquidity || 0);
          if (winningShares > 0 && prediction.shares > 0) {
            prediction.payout = (prediction.shares / winningShares) * totalLiquidity;
          }
        }
        prediction.status = 'settled';
      }
      
      if (prediction.type === 'boost') {
        boostPredictions.push(prediction);
      }
      
      await prediction.save();
    }

    // Calculate and update payouts for boost predictions
    if (boostPredictions.length > 0) {
      await calculateBoostPayouts(null, poll._id);
    }

    res.json(poll);
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
    const { status } = req.body;
    const match = await Match.findByIdAndUpdate(req.params.id, { status }, { new: true });
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
    
    if (setting) {
      setting.value = value;
      await setting.save();
    } else {
      setting = new Settings({
        key: req.params.key,
        value,
        description: req.params.key === 'dailyFreePlayLimit' ? 'Number of free predictions per day' : '',
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
      prediction.payout = distributablePool * share;
      await prediction.save();
    }
  }
}

module.exports = router;
