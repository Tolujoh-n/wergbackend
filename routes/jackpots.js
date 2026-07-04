const express = require('express');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { auth, optionalAuth } = require('../middleware/auth');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const { payoutToWei } = require('../utils/claimEligibility');
const {
  getClaimSignerAddress,
  signJackpotWithdrawPayload,
} = require('../utils/claimAuth');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Cup = require('../models/Cup');
const { reserveTx, finalizeTx } = require('../utils/processedTx');
const {
  readJackpotBalanceOnChain,
  setJackpotBalanceOnChain,
} = require('../utils/jackpotOnChainSync');

const JACKPOT_CLAIM_LOCK_MS = 35 * 60 * 1000;

async function releaseStaleJackpotReservation(userId) {
  const user = await User.findById(userId).select(
    'jackpotBalancePending jackpotWithdrawLockedAt jackpotWithdrawInProgress'
  );
  if (!user || !(user.jackpotBalancePending > 0)) return;
  const lockedAt = user.jackpotWithdrawLockedAt;
  if (!lockedAt) return;
  if (Date.now() - new Date(lockedAt).getTime() < JACKPOT_CLAIM_LOCK_MS) return;

  const pending = user.jackpotBalancePending;
  await User.updateOne(
    { _id: userId },
    {
      $inc: { jackpotBalance: pending },
      $set: { jackpotBalancePending: 0, jackpotWithdrawInProgress: false },
    }
  );
  await Prediction.updateMany(
    { user: userId, jackpotClaimInProgress: true, jackpotClaimed: { $ne: true } },
    { $set: { jackpotClaimInProgress: false } }
  );
}

async function rollbackJackpotReservation(userId, predictionId, amount) {
  await User.updateOne(
    { _id: userId },
    {
      $inc: { jackpotBalance: amount, jackpotBalancePending: -amount },
      $set: { jackpotWithdrawInProgress: false },
    }
  );
  if (predictionId) {
    await Prediction.updateOne(
      { _id: predictionId },
      { $set: { jackpotClaimInProgress: false } }
    );
  }
}

async function assertWalletLinkedToUser({ userId, walletAddress }) {
  let reqAddr;
  try {
    reqAddr = ethers.getAddress(walletAddress);
  } catch {
    const err = new Error('Invalid walletAddress');
    err.statusCode = 400;
    throw err;
  }
  const addrLower = normalizeWalletAddress(reqAddr);
  const link = await WalletLink.findOne({ walletAddress: addrLower }).lean();
  if (!link) {
    const err = new Error('Link a wallet to your account');
    err.statusCode = 400;
    throw err;
  }
  if (String(link.user) !== String(userId)) {
    const err = new Error('Connect the wallet linked to your profile');
    err.statusCode = 403;
    throw err;
  }
  return reqAddr;
}

const router = express.Router();

/**
 * When logged in, attach per-card jackpot share for this user (equal split among winners, same as resolve).
 * `userJackpotWinAmount`: null = not resolved yet; 0 = lost or no share; >0 = USDC won from that pool.
 */
function userJackpotWinFields({
  userId,
  predictions,
  jackpotType,
  resolved,
  originalPool,
  poolFallback,
  isWinnerTest,
}) {
  if (!userId) return {};
  const uid = String(userId);
  const mine = predictions.filter((p) => String(p.user) === uid && p.type === jackpotType);
  if (!mine.length) return {};
  if (!resolved) {
    return { userJackpotParticipated: true, userJackpotWinAmount: null };
  }
  const won = mine.some(isWinnerTest);
  if (!won) {
    return { userJackpotParticipated: true, userJackpotWinAmount: 0 };
  }
  const trackedPayout = mine
    .filter(isWinnerTest)
    .reduce((s, p) => s + (Number(p.jackpotPayout) || 0), 0);
  if (trackedPayout > 0) {
    return { userJackpotParticipated: true, userJackpotWinAmount: trackedPayout };
  }
  const pool = Number(originalPool) > 0 ? Number(originalPool) : Number(poolFallback) || 0;
  const winningPreds = predictions.filter((p) => p.type === jackpotType && isWinnerTest(p));
  let totalTickets = 0;
  for (const p of winningPreds) {
    totalTickets += Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
  }
  if (!totalTickets || !(pool > 0)) {
    return { userJackpotParticipated: true, userJackpotWinAmount: 0 };
  }
  const userTickets = mine.reduce((s, p) => s + Math.max(1, parseInt(p.ticketsStaked, 10) || 1), 0);
  return { userJackpotParticipated: true, userJackpotWinAmount: (pool / totalTickets) * userTickets };
}

function normalizeWalletAddress(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (!s) return null;
  return s.toLowerCase();
}

// Get jackpots
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    
    // Calculate jackpot pools from actual match/poll pools
    const matches = await Match.find({});
    const polls = await Poll.find({});
    console.log(`[Jackpots] Found ${matches.length} matches and ${polls.length} polls`);
    
    // Sum up all free and boost jackpot pools (only from unresolved matches/polls)
    const unresolvedMatches = matches.filter(m => !m.isResolved);
    const unresolvedPolls = polls.filter(p => !p.isResolved);
    console.log(`[Jackpots] Unresolved: ${unresolvedMatches.length} matches, ${unresolvedPolls.length} polls`);
    
    const freePool = unresolvedMatches.reduce((sum, m) => sum + (m.freeJackpotPool || 0), 0) +
                     unresolvedPolls.reduce((sum, p) => sum + (p.freeJackpotPool || 0), 0);
    console.log(`[Jackpots] Jackpot pool: ${freePool}`);
    
    const jackpots = [
      {
        _id: 'jackpot',
        name: 'Jackpot',
        type: 'free',
        amount: Math.max(freePool, freePool > 0 ? 0.01 : 0),
        participants: await getEligibleUsers('free', 'daily'),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        minStreak: 3,
        minPredictions: 5,
      },
      {
        _id: 'tournament-free',
        name: 'Tournament Free Jackpot',
        type: 'free',
        amount: Math.max(Math.floor(freePool * 0.5), freePool > 0 ? 1 : 0),
        participants: await getEligibleUsers('free', 'tournament'),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        minStreak: 10,
        minPredictions: 20,
      },
    ];
    
    const filtered = type && type !== 'all' 
      ? jackpots.filter(j => j.type === type)
      : jackpots;
    
    // Ensure minimum values for display - always show jackpots even if pools are low
    for (const jackpot of filtered) {
      // Always set a minimum amount for display purposes
      if (jackpot.amount <= 0) {
        jackpot.amount = jackpot.type === 'free' ? 100 : 0.1;
      }
      if (jackpot.participants <= 0) {
        jackpot.participants = 1;
      }
    }
    
    // Add user eligibility if authenticated (optional)
    if (req.user) {
      const userId = req.user._id;
      for (const jackpot of filtered) {
        jackpot.userEligible = await checkEligibility(userId, jackpot);
        jackpot.userChance = jackpot.userEligible && jackpot.participants > 0 
          ? (1 / jackpot.participants * 100).toFixed(2) 
          : 0;
      }
    }
    
    console.log(`[Jackpots] Returning ${filtered.length} jackpots`);
    res.json(filtered);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get jackpots for a specific cup
router.get('/cup/:cupSlug', async (req, res) => {
  try {
    const { cupSlug } = req.params;
    const { type } = req.query;
    
    const cup = await Cup.findOne({ slug: cupSlug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }
    
    // Get actual jackpot pools from matches and polls in this cup (only unresolved)
    const matches = await Match.find({ cup: cup._id });
    const polls = await Poll.find({ cup: cup._id });
    const matchIds = matches.map(m => m._id);
    
    const unresolvedMatches = matches.filter(m => !m.isResolved);
    const unresolvedPolls = polls.filter(p => !p.isResolved);
    
    const freePool = unresolvedMatches.reduce((sum, m) => sum + (m.freeJackpotPool || 0), 0) +
                     unresolvedPolls.reduce((sum, p) => sum + (p.freeJackpotPool || 0), 0);
    
    const jackpots = [
      {
        _id: `cup-${cupSlug}-jackpot`,
        name: `${cup.name} Jackpot`,
        type: 'free',
        amount: Math.max(freePool, freePool > 0 ? 0.01 : 0),
        participants: await getEligibleUsers('free', 'cup', cup._id),
        endDate: cup.endDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        minStreak: 5,
        minPredictions: 10,
      },
    ];
    
    const filtered = type && type !== 'all' 
      ? jackpots.filter(j => j.type === type)
      : jackpots;
    
    // Ensure minimum values for display - always show jackpots
    for (const jackpot of filtered) {
      if (jackpot.amount <= 0) {
        jackpot.amount = jackpot.type === 'free' ? 100 : 0.1;
      }
      if (jackpot.participants <= 0) {
        jackpot.participants = 1;
      }
    }
    
    // Add user eligibility if authenticated (optional)
    if (req.user) {
      const userId = req.user._id;
      for (const jackpot of filtered) {
        jackpot.userEligible = await checkEligibility(userId, jackpot, cup._id);
        jackpot.userChance = jackpot.userEligible && jackpot.participants > 0
          ? (1 / jackpot.participants * 100).toFixed(2)
          : 0;
      }
    }
    
    console.log(`[Jackpots Cup] Returning ${filtered.length} jackpots`);
    res.json(filtered);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

async function getEligibleUsers(type, period, cupId = null) {
  const users = await User.find();
  let eligible = 0;
  
  for (const user of users) {
    let predictions;
    if (cupId) {
      const matchIds = await getMatchIds(cupId);
      const pollIds = await getPollIds(cupId);
      predictions = await Prediction.find({
        user: user._id,
        $or: [
          { match: { $in: matchIds } },
          { poll: { $in: pollIds } }
        ]
      });
    } else {
      predictions = await Prediction.find({ user: user._id });
    }
    
    const correctPredictions = predictions.filter(p => p.status === 'won' && p.type === type);
    const streak = user.streak || 0;
    
    if (period === 'daily') {
      if (correctPredictions.length >= 5 && streak >= 3) eligible++;
    } else {
      if (correctPredictions.length >= 20 && streak >= 10) eligible++;
    }
  }
  
  return eligible;
}

async function checkEligibility(userId, jackpot, cupId = null) {
  const user = await User.findById(userId);
  if (!user) return false;
  
  let predictions;
  if (cupId) {
    const matchIds = await getMatchIds(cupId);
    const pollIds = await getPollIds(cupId);
    predictions = await Prediction.find({
      user: userId,
      $or: [
        { match: { $in: matchIds } },
        { poll: { $in: pollIds } }
      ]
    });
  } else {
    predictions = await Prediction.find({ user: userId });
  }
  
  const correctPredictions = predictions.filter(p => p.status === 'won' && p.type === jackpot.type);
  const streak = user.streak || 0;
  
  return correctPredictions.length >= jackpot.minPredictions && streak >= jackpot.minStreak;
}

async function getMatchIds(cupId) {
  const matches = await Match.find({ cup: cupId });
  return matches.map(m => m._id);
}

async function getPollIds(cupId) {
  const polls = await Poll.find({ cup: cupId });
  return polls.map(p => p._id);
}

// Get per-match/poll jackpot cards
router.get('/items', optionalAuth, async (req, res) => {
  try {
    const { type, page = 1 } = req.query;
    const pageNum = parseInt(page) || 1;
    const limit = 12;
    const skip = (pageNum - 1) * limit;
    
    // Get all matches and polls with predictions
    const matches = await Match.find({}).populate('cup', 'name slug').sort({ createdAt: -1 });
    const polls = await Poll.find({}).populate('cup', 'name slug').sort({ createdAt: -1 });
    
    const jackpotItems = [];
    
    // Process matches
    for (const match of matches) {
      // Get predictions for this match
      const predictions = await Prediction.find({ match: match._id });
      const freePredictions = predictions.filter(p => p.type === 'free');
      const boostPredictions = predictions.filter(p => p.type === 'boost');
      
      // Calculate participants (unique users)
      const freeParticipants = [...new Set(freePredictions.map(p => p.user.toString()))].length;
      const boostParticipants = [...new Set(boostPredictions.map(p => p.user.toString()))].length;
      
      // Calculate winners and losers (unique users, not prediction count)
      // For free predictions: status === 'won' or 'lost'
      // For boost predictions: after resolution, status is 'settled', so check payout (winners have payout > 0, losers have payout = 0 and originalStake > 0)
      const freeWinningUsers = [...new Set(freePredictions.filter(p => p.status === 'won').map(p => p.user.toString()))];
      const freeLosingUsers = [...new Set(freePredictions.filter(p => p.status === 'lost').map(p => p.user.toString()))];
      const freeWinners = freeWinningUsers.length;
      const freeLosers = freeLosingUsers.length;
      
      // For boost: winners have payout > 0, losers have payout = 0 and (originalStake > 0 or totalStake > 0 or amount > 0)
      const boostWinningUsers = [...new Set(boostPredictions.filter(p => {
        if (p.status === 'won') return true;
        if (p.status === 'settled' && (p.payout || 0) > 0) return true;
        return false;
      }).map(p => p.user.toString()))];
      const boostLosingUsers = [...new Set(boostPredictions.filter(p => {
        if (p.status === 'lost') return true;
        if (p.status === 'settled' && (p.payout || 0) === 0 && ((p.originalStake || 0) > 0 || (p.totalStake || 0) > 0 || (p.amount || 0) > 0)) return true;
        return false;
      }).map(p => p.user.toString()))];
      const boostWinners = boostWinningUsers.length;
      const boostLosers = boostLosingUsers.length;
      
      // Get display result (team name instead of TEAMA/TEAMB)
      let displayResult = match.result || '';
      if (displayResult === 'TeamA' || displayResult.toLowerCase() === 'teama') {
        displayResult = match.teamA || 'Team A';
      } else if (displayResult === 'TeamB' || displayResult.toLowerCase() === 'teamb') {
        displayResult = match.teamB || 'Team B';
      } else if (displayResult === 'Draw' || displayResult.toLowerCase() === 'draw') {
        displayResult = 'Draw';
      }
      
      // Get jackpot amounts (original distributed + any admin top-ups since resolve)
      const freeAmount = match.isResolved
        ? (match.originalFreeJackpotPool || 0) + (match.freeJackpotPool || 0)
        : (match.freeJackpotPool || 0);
      const freeTotalTickets = freePredictions.reduce(
        (sum, p) => sum + Math.max(1, parseInt(p.ticketsStaked, 10) || 1),
        0
      );
      const userFreeTickets = req.user
        ? freePredictions
            .filter((p) => String(p.user) === String(req.user._id))
            .reduce((sum, p) => sum + Math.max(1, parseInt(p.ticketsStaked, 10) || 1), 0)
        : 0;
      if (freeParticipants > 0 || freeAmount > 0) {
        jackpotItems.push({
          _id: `match-${match._id}-jackpot`,
          itemId: match._id,
          itemType: 'match',
          type: 'free',
          title: match.teamA + ' vs ' + match.teamB,
          cup: match.cup ? { name: match.cup.name, slug: match.cup.slug } : null,
          status: match.isResolved ? 'resolved' : 'pending',
          amount: freeAmount,
          totalTickets: freeTotalTickets,
          userTickets: userFreeTickets,
          participants: freeParticipants || 0,
          winners: freeWinners || 0,
          losers: freeLosers || 0,
          date: match.date,
          resolvedAt: match.isResolved ? match.updatedAt : null,
          result: displayResult,
          ...userJackpotWinFields({
            userId: req.user?._id,
            predictions,
            jackpotType: 'free',
            resolved: !!match.isResolved,
            originalPool: match.originalFreeJackpotPool,
            poolFallback: freeAmount,
            isWinnerTest: (p) => p.status === 'won',
          }),
        });
      }
    }
    
    // Process polls
    for (const poll of polls) {
      // Get predictions for this poll
      const predictions = await Prediction.find({ poll: poll._id });
      const freePredictions = predictions.filter(p => p.type === 'free');
      const boostPredictions = predictions.filter(p => p.type === 'boost');
      
      // Calculate participants (unique users)
      const freeParticipants = [...new Set(freePredictions.map(p => p.user.toString()))].length;
      const boostParticipants = [...new Set(boostPredictions.map(p => p.user.toString()))].length;
      
      // Calculate winners and losers (unique users, not prediction count)
      // For free predictions: status === 'won' or 'lost'
      // For boost predictions: after resolution, status is 'settled', so check payout (winners have payout > 0, losers have payout = 0 and originalStake > 0)
      const freeWinningUsers = [...new Set(freePredictions.filter(p => p.status === 'won').map(p => p.user.toString()))];
      const freeLosingUsers = [...new Set(freePredictions.filter(p => p.status === 'lost').map(p => p.user.toString()))];
      const freeWinners = freeWinningUsers.length;
      const freeLosers = freeLosingUsers.length;
      
      // For boost: winners have payout > 0, losers have payout = 0 and (originalStake > 0 or totalStake > 0 or amount > 0)
      const boostWinningUsers = [...new Set(boostPredictions.filter(p => {
        if (p.status === 'won') return true;
        if (p.status === 'settled' && (p.payout || 0) > 0) return true;
        return false;
      }).map(p => p.user.toString()))];
      const boostLosingUsers = [...new Set(boostPredictions.filter(p => {
        if (p.status === 'lost') return true;
        if (p.status === 'settled' && (p.payout || 0) === 0 && ((p.originalStake || 0) > 0 || (p.totalStake || 0) > 0 || (p.amount || 0) > 0)) return true;
        return false;
      }).map(p => p.user.toString()))];
      const boostWinners = boostWinningUsers.length;
      const boostLosers = boostLosingUsers.length;
      
      // Get display result (option name for polls)
      let displayResult = poll.result || '';
      if (poll.optionType === 'options' && poll.options) {
        // For option-based polls, result is the option text
        const winningOption = poll.options.find(opt => opt.text === poll.result);
        if (winningOption) {
          displayResult = winningOption.text;
        }
      } else {
        // For Yes/No polls, keep YES/NO as is
        if (displayResult.toUpperCase() === 'YES' || displayResult.toUpperCase() === 'NO') {
          displayResult = displayResult.toUpperCase();
        }
      }
      
      // Get jackpot amounts (original distributed + any admin top-ups since resolve)
      const freeAmount = poll.isResolved
        ? (poll.originalFreeJackpotPool || 0) + (poll.freeJackpotPool || 0)
        : (poll.freeJackpotPool || 0);
      const freeTotalTickets = freePredictions.reduce(
        (sum, p) => sum + Math.max(1, parseInt(p.ticketsStaked, 10) || 1),
        0
      );
      const userFreeTickets = req.user
        ? freePredictions
            .filter((p) => String(p.user) === String(req.user._id))
            .reduce((sum, p) => sum + Math.max(1, parseInt(p.ticketsStaked, 10) || 1), 0)
        : 0;
      if (freeParticipants > 0 || freeAmount > 0) {
        jackpotItems.push({
          _id: `poll-${poll._id}-jackpot`,
          itemId: poll._id,
          itemType: 'poll',
          type: 'free',
          title: poll.question,
          cup: poll.cup ? { name: poll.cup.name, slug: poll.cup.slug } : null,
          status: poll.isResolved ? 'resolved' : 'pending',
          amount: freeAmount,
          totalTickets: freeTotalTickets,
          userTickets: userFreeTickets,
          participants: freeParticipants || 0,
          winners: freeWinners || 0,
          losers: freeLosers || 0,
          date: poll.createdAt,
          resolvedAt: poll.isResolved ? poll.updatedAt : null,
          result: displayResult,
          ...userJackpotWinFields({
            userId: req.user?._id,
            predictions,
            jackpotType: 'free',
            resolved: !!poll.isResolved,
            originalPool: poll.originalFreeJackpotPool,
            poolFallback: freeAmount,
            isWinnerTest: (p) => p.status === 'won',
          }),
        });
      }
    }
    
    // Filter by type if specified
    let filtered = jackpotItems;
    if (type && type !== 'all') {
      filtered = jackpotItems.filter(item => item.type === type);
    }
    
    // Sort by date (most recent first)
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Pagination
    const total = filtered.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = filtered.slice(skip, skip + limit);
    
    res.json({
      items: paginated,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalItems: total,
        hasNext: skip + limit < total,
        hasPrev: pageNum > 1
      }
    });
  } catch (error) {
    console.error('Error fetching jackpot items:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get user jackpot stats
router.get('/user/stats', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const available = Math.max(0, (user.jackpotBalance || 0));
    res.json({
      jackpotBalance: available,
      jackpotBalancePending: user.jackpotBalancePending || 0,
      jackpotWithdrawn: user.jackpotWithdrawn || 0,
      jackpotWins: user.jackpotWins || 0,
      totalEarned: available + (user.jackpotWithdrawn || 0) + (user.jackpotBalancePending || 0),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * Per-prediction free jackpot claim: reserves DB balance at sign time and checks on-chain cap.
 */
router.post('/claim/:predictionId/authorization', auth, async (req, res) => {
  let reservedAmount = 0;
  let predictionId = req.params.predictionId;

  try {
    await releaseStaleJackpotReservation(req.user._id);

    const { walletAddress } = req.body || {};
    if (!walletAddress) {
      return res.status(400).json({ message: 'walletAddress is required' });
    }

    const claimSignerAddress = getClaimSignerAddress();
    if (!claimSignerAddress) {
      return res.status(503).json({
        message: 'Claims are not configured (set CLAIM_AUTH_PRIVATE_KEY on the server)',
      });
    }

    const contractAddressRaw =
      process.env.CONTRACT_ADDRESS || process.env.REACT_APP_CONTRACT_ADDRESS;
    const { getChainId } = require('../utils/chainConfig');
    const chainId = getChainId();
    if (!contractAddressRaw) {
      return res.status(500).json({ message: 'CONTRACT_ADDRESS not configured on server' });
    }

    const prediction = await Prediction.findById(req.params.predictionId);
    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }
    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    if (prediction.type !== 'free') {
      return res.status(400).json({ message: 'Only free predictions use jackpot claim' });
    }
    if (prediction.status !== 'won') {
      return res.status(400).json({ message: 'Prediction did not win' });
    }
    if (prediction.jackpotClaimed) {
      return res.status(400).json({ message: 'Jackpot already claimed for this win' });
    }
    const withdrawAmount = Number(prediction.jackpotPayout) || 0;
    if (!(withdrawAmount > 0)) {
      return res.status(400).json({ message: 'No jackpot payout for this prediction' });
    }
    reservedAmount = withdrawAmount;

    const reqAddr = await assertWalletLinkedToUser({
      userId: req.user._id,
      walletAddress,
    });

    const userReserved = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        jackpotBalance: { $gte: withdrawAmount },
        jackpotWithdrawInProgress: { $ne: true },
      },
      {
        $inc: { jackpotBalance: -withdrawAmount, jackpotBalancePending: withdrawAmount },
        $set: { jackpotWithdrawInProgress: true, jackpotWithdrawLockedAt: new Date() },
      },
      { new: true }
    );
    if (!userReserved) {
      return res.status(409).json({
        message: 'Insufficient balance or another jackpot claim is in progress',
      });
    }

    const predLocked = await Prediction.findOneAndUpdate(
      {
        _id: prediction._id,
        jackpotClaimed: { $ne: true },
        jackpotClaimInProgress: { $ne: true },
      },
      { $set: { jackpotClaimInProgress: true, jackpotClaimLockedAt: new Date() } },
      { new: true }
    );
    if (!predLocked) {
      await rollbackJackpotReservation(req.user._id, prediction._id, withdrawAmount);
      return res.status(409).json({ message: 'Jackpot claim already in progress or completed' });
    }

    const dbTotal =
      (userReserved.jackpotBalance || 0) + (userReserved.jackpotBalancePending || 0);
    const onChain = await readJackpotBalanceOnChain(reqAddr);
    if (onChain == null || onChain + 0.02 < withdrawAmount) {
      try {
        await setJackpotBalanceOnChain(reqAddr, dbTotal);
      } catch (syncErr) {
        await rollbackJackpotReservation(req.user._id, prediction._id, withdrawAmount);
        return res.status(503).json({
          message: syncErr.message || 'Could not sync on-chain jackpot balance',
        });
      }
    }

    const amountWei = payoutToWei(withdrawAmount);
    const deadlineSec = Math.floor(Date.now() / 1000) + 30 * 60;
    const nonce = ethers.hexlify(crypto.randomBytes(32));
    const contractAddress = ethers.getAddress(contractAddressRaw);

    const { signature } = await signJackpotWithdrawPayload({
      userAddress: reqAddr,
      amountWei,
      nonce,
      deadlineSec,
      chainId,
      contractAddress,
    });

    res.json({
      claimSignerAddress,
      contractAddress,
      chainId,
      amountWei: amountWei.toString(),
      amountUsdc: withdrawAmount,
      predictionId: String(prediction._id),
      nonce,
      deadline: deadlineSec,
      signature,
    });
  } catch (error) {
    console.error('jackpot claim authorization:', error);
    if (reservedAmount > 0) {
      try {
        await rollbackJackpotReservation(req.user._id, predictionId, reservedAmount);
      } catch (_) {
        /* ignore */
      }
    }
    const code = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.status(code).json({ message: error.message || 'Failed to authorize jackpot claim' });
  }
});

/** Confirm on-chain jackpot claim after successful tx. */
router.post('/claim/:predictionId/confirm', auth, async (req, res) => {
  try {
    const { txHash } = req.body || {};
    const prediction = await Prediction.findById(req.params.predictionId);
    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }
    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    if (prediction.jackpotClaimed) {
      return res.status(200).json({ message: 'Already claimed', alreadyProcessed: true });
    }

    const withdrawAmount = Number(prediction.jackpotPayout) || 0;
    if (!(withdrawAmount > 0)) {
      return res.status(400).json({ message: 'No jackpot payout for this prediction' });
    }

    if (txHash && String(txHash).trim()) {
      const { reserved } = await reserveTx('jackpot_withdraw', txHash, {
        user: req.user._id,
        predictionId: String(prediction._id),
        amount: withdrawAmount,
      });
      if (!reserved) {
        const fresh = await User.findById(req.user._id);
        return res.status(200).json({
          message: 'Withdrawal already recorded',
          alreadyProcessed: true,
          remainingBalance: fresh?.jackpotBalance ?? 0,
          totalWithdrawn: fresh?.jackpotWithdrawn ?? 0,
        });
      }
    }

    const updatedUser = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        jackpotBalancePending: { $gte: withdrawAmount },
      },
      {
        $inc: { jackpotBalancePending: -withdrawAmount, jackpotWithdrawn: withdrawAmount },
        $set: { jackpotWithdrawInProgress: false },
      },
      { new: true }
    );
    if (!updatedUser) {
      return res.status(400).json({
        message: 'No pending jackpot reservation for this amount. Contact support if USDC was received.',
      });
    }

    const updatedPred = await Prediction.findOneAndUpdate(
      { _id: prediction._id, jackpotClaimed: { $ne: true } },
      {
        $set: {
          jackpotClaimed: true,
          jackpotClaimInProgress: false,
          ...(txHash ? { jackpotClaimTxHash: String(txHash).trim() } : {}),
        },
      },
      { new: true }
    );
    if (!updatedPred) {
      return res.status(400).json({ message: 'Jackpot already claimed for this prediction' });
    }

    if (txHash && String(txHash).trim()) {
      await finalizeTx('jackpot_withdraw', txHash, { 'meta.completed': true });
    }

    res.json({
      message: 'Jackpot claimed successfully',
      withdrawn: withdrawAmount,
      remainingBalance: updatedUser.jackpotBalance,
      totalWithdrawn: updatedUser.jackpotWithdrawn,
      prediction: updatedPred,
    });
  } catch (error) {
    console.error('jackpot claim confirm:', error);
    res.status(500).json({ message: error.message || 'Failed to confirm jackpot claim' });
  }
});

/** @deprecated Use POST /jackpots/claim/:predictionId/authorization */
router.post('/withdraw/authorization', auth, async (req, res) => {
  res.status(410).json({
    message:
      'Bulk jackpot withdraw is disabled. Claim each free-jackpot win from the event Free details page.',
  });
});

/** @deprecated Use POST /jackpots/claim/:predictionId/confirm */
router.post('/withdraw', auth, async (req, res) => {
  res.status(410).json({
    message:
      'Bulk jackpot withdraw is disabled. Claim each free-jackpot win from the event Free details page.',
  });
});

module.exports = router;
