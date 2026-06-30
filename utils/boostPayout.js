/**
 * Boost prize pool: winners on the winning outcome split the full boostPool
 * in proportion to their net stake (admin top-ups included).
 */

function normalizeBoostOutcomeKey(outcome, item, kind = 'match') {
  const o = String(outcome || '').trim();
  if (!o) return o;
  if (kind === 'match' && item) {
    const teamA = String(item.teamA || '').trim();
    const teamB = String(item.teamB || '').trim();
    const lower = o.toLowerCase();
    if (o === 'TeamA' || lower === 'teama' || (teamA && lower === teamA.toLowerCase())) return 'TeamA';
    if (o === 'TeamB' || lower === 'teamb' || (teamB && lower === teamB.toLowerCase())) return 'TeamB';
    if (o === 'Draw' || lower === 'draw') return 'Draw';
  }
  return o;
}

/**
 * @param {object} params
 * @param {number} params.boostPool
 * @param {import('mongoose').Document[]} params.boostPredictions - all boost preds (won/lost set)
 */
function applyBoostPoolPayouts({ boostPool, boostPredictions }) {
  const pool = Math.max(0, Number(boostPool) || 0);
  const originalStakes = new Map();
  for (const prediction of boostPredictions) {
    // Fall back to originalStake: a prior resolve zeroes the stake of losing picks, so on a
    // result change a now-winning pick must recover its real stake to be weighted correctly.
    const stake = prediction.totalStake || prediction.amount || prediction.originalStake || 0;
    originalStakes.set(prediction._id.toString(), stake);
  }

  const winningBoostPredictions = boostPredictions.filter((p) => p.status === 'won');
  const totalWinningStake = winningBoostPredictions.reduce((sum, p) => {
    return sum + (originalStakes.get(p._id.toString()) || 0);
  }, 0);

  for (const prediction of boostPredictions) {
    const originalStake = originalStakes.get(prediction._id.toString()) || 0;
    prediction.originalStake = originalStake;

    if (prediction.status === 'won' && totalWinningStake > 0 && pool > 0) {
      prediction.payout = pool * (originalStake / totalWinningStake);
    } else if (prediction.status === 'won') {
      prediction.payout = originalStake;
    } else {
      prediction.payout = 0;
      prediction.amount = 0;
      prediction.totalStake = 0;
    }
    prediction.status = 'settled';
  }
}

/**
 * Aggregate net stakes per outcome for boost potential-win previews.
 */
async function getBoostPoolStats({ matchId, pollId }) {
  const Prediction = require('../models/Prediction');
  const Match = require('../models/Match');
  const Poll = require('../models/Poll');

  const query = { type: 'boost' };
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
  const stakesByOutcome = {};
  let totalNetStakes = 0;
  for (const p of predictions) {
    const stake = Number(p.totalStake ?? p.amount ?? 0) || 0;
    if (stake <= 0) continue;
    const key = normalizeBoostOutcomeKey(p.outcome, item, kind);
    stakesByOutcome[key] = (stakesByOutcome[key] || 0) + stake;
    totalNetStakes += stake;
  }

  const boostPool = Number(item.boostPool) || 0;
  const { getGoldenTicketBoostRate } = require('../services/ticketService');
  const goldenTicketBoostRate = await getGoldenTicketBoostRate();
  return {
    boostPool,
    stakesByOutcome,
    totalNetStakes,
    adminTopUp: Math.max(0, boostPool - totalNetStakes),
    goldenTicketBoostRate,
  };
}

module.exports = {
  normalizeBoostOutcomeKey,
  applyBoostPoolPayouts,
  getBoostPoolStats,
};
