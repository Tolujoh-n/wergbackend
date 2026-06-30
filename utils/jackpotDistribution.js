const { normalizeBoostOutcomeKey } = require('./boostPayout');

/**
 * Distribute event freeJackpotPool to free winners weighted by ticketsStaked.
 * @param {import('mongoose').Document[]} freeWinningPredictions
 * @param {number} poolAmount
 * @returns {Map<string, number>} userId -> payout
 */
function distributeJackpotByTickets(freeWinningPredictions, poolAmount) {
  const payouts = new Map();
  if (!poolAmount || poolAmount <= 0 || !freeWinningPredictions?.length) return payouts;

  let totalTickets = 0;
  for (const p of freeWinningPredictions) {
    totalTickets += Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
  }
  if (totalTickets <= 0) return payouts;

  const perTicket = poolAmount / totalTickets;
  for (const p of freeWinningPredictions) {
    const uid = p.user.toString();
    const t = Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
    payouts.set(uid, (payouts.get(uid) || 0) + perTicket * t);
  }
  return payouts;
}

/**
 * Preview: share of freeJackpotPool if this pick wins (weighted by tickets on same outcome).
 */
function estimateFreeJackpotPotentialWin({ freeJackpotPoolUsdc = 0, userTickets = 1, outcomeTotalTickets = 0 }) {
  const pool = Math.max(0, Number(freeJackpotPoolUsdc) || 0);
  const userT = Math.max(1, parseInt(userTickets, 10) || 1);
  const outcomeTotal = Math.max(userT, Number(outcomeTotalTickets) || 0);
  if (!(pool > 0)) return null;
  return pool * (userT / outcomeTotal);
}

async function getFreeJackpotStats({ matchId, pollId, userId }) {
  const Prediction = require('../models/Prediction');
  const Match = require('../models/Match');
  const Poll = require('../models/Poll');

  const query = { type: 'free' };
  let item;
  let kind = 'match';
  if (matchId) {
    query.match = matchId;
    item = await Match.findById(matchId).lean();
    if (!item) return null;
  } else if (pollId) {
    query.poll = pollId;
    item = await Poll.findById(pollId).lean();
    kind = 'poll';
    if (!item) return null;
  } else {
    return null;
  }

  const predictions = await Prediction.find(query).lean();
  const ticketsByOutcome = {};
  let totalTickets = 0;
  let userTickets = 0;
  for (const p of predictions) {
    const key = normalizeBoostOutcomeKey(p.outcome, item, kind);
    const t = Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
    ticketsByOutcome[key] = (ticketsByOutcome[key] || 0) + t;
    totalTickets += t;
    if (userId && String(p.user) === String(userId)) {
      userTickets += t;
    }
  }

  const pool = item.isResolved
    ? (Number(item.originalFreeJackpotPool) || 0) + (Number(item.freeJackpotPool) || 0)
    : Number(item.freeJackpotPool) || 0;

  let userJackpotWinAmount = null;
  if (userId && item.isResolved) {
    const mine = predictions.filter(
      (p) => String(p.user) === String(userId) && p.status === 'won'
    );
    const tracked = mine.reduce((s, p) => s + (Number(p.jackpotPayout) || 0), 0);
    if (tracked > 0) {
      userJackpotWinAmount = tracked;
    } else if (mine.length > 0 && pool > 0) {
      let winTotalTickets = 0;
      const winningPreds = predictions.filter((p) => p.status === 'won');
      for (const p of winningPreds) {
        winTotalTickets += Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
      }
      if (winTotalTickets > 0) {
        userJackpotWinAmount = (pool / winTotalTickets) * userTickets;
      } else {
        userJackpotWinAmount = 0;
      }
    } else if (mine.length === 0) {
      userJackpotWinAmount = 0;
    }
  }

  return {
    freeJackpotPool: pool,
    ticketsByOutcome,
    totalTickets,
    userTickets,
    userJackpotWinAmount,
  };
}

module.exports = {
  distributeJackpotByTickets,
  estimateFreeJackpotPotentialWin,
  getFreeJackpotStats,
};
