const User = require('../models/User');
const Prediction = require('../models/Prediction');

function ticketWeight(p) {
  return Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
}

function boostStakeWeight(p) {
  return Number(p.originalStake ?? p.totalStake ?? p.amount ?? 0) || 0;
}

function isFreeWinner(p) {
  return p.status === 'won';
}

function isBoostWinner(p) {
  if (p.status === 'won') return true;
  if (p.status === 'settled' && (p.payout || 0) > 0) return true;
  return false;
}

/**
 * Distribute an admin top-up on a resolved event to current free-jackpot winners (by tickets).
 */
async function distributeFreeJackpotTopUp({ item, kind, amount }) {
  const amt = Number(amount) || 0;
  if (!(amt > 0)) return { distributed: 0 };

  const query =
    kind === 'match'
      ? { match: item._id, type: 'free' }
      : { poll: item._id, type: 'free' };
  const predictions = await Prediction.find(query);
  const winners = predictions.filter(isFreeWinner);
  if (!winners.length) return { distributed: 0, reason: 'no_winners' };

  let totalTickets = 0;
  for (const p of winners) totalTickets += ticketWeight(p);
  if (!totalTickets) return { distributed: 0 };

  const perTicket = amt / totalTickets;
  const perUser = new Map();

  for (const p of winners) {
    const share = perTicket * ticketWeight(p);
    p.jackpotPayout = (p.jackpotPayout || 0) + share;
    await p.save();
    const uid = p.user.toString();
    perUser.set(uid, (perUser.get(uid) || 0) + share);
  }

  for (const [userId, credit] of perUser.entries()) {
    const user = await User.findById(userId);
    if (user && credit > 0) {
      user.jackpotBalance = (user.jackpotBalance || 0) + credit;
      user.jackpotWins = (user.jackpotWins || 0) + 1;
      await user.save();
    }
  }

  item.originalFreeJackpotPool = (item.originalFreeJackpotPool || 0) + amt;
  item.freeJackpotPool = Math.max(0, (item.freeJackpotPool || 0) - amt);
  await item.save();

  return { distributed: amt, winners: winners.length };
}

/**
 * Distribute an admin boost-pool top-up on a resolved event to current boost winners (by stake).
 */
async function distributeBoostPoolTopUp({ item, kind, amount }) {
  const amt = Number(amount) || 0;
  if (!(amt > 0)) return { distributed: 0 };

  const query =
    kind === 'match'
      ? { match: item._id, type: 'boost' }
      : { poll: item._id, type: 'boost' };
  const predictions = await Prediction.find(query);
  const winners = predictions.filter(isBoostWinner);
  if (!winners.length) return { distributed: 0, reason: 'no_winners' };

  let totalStake = 0;
  for (const p of winners) totalStake += boostStakeWeight(p);
  if (!totalStake) return { distributed: 0 };

  for (const p of winners) {
    const stake = boostStakeWeight(p);
    const increment = amt * (stake / totalStake);
    p.payout = (p.payout || 0) + increment;
    if (p.status !== 'settled') p.status = 'settled';
    await p.save();
  }

  item.originalBoostPool = (item.originalBoostPool || 0) + amt;
  await item.save();

  return { distributed: amt, winners: winners.length };
}

async function getTicketTotalsByEvent(ids, kind) {
  if (!ids?.length) return new Map();
  const field = kind === 'match' ? 'match' : 'poll';
  const preds = await Prediction.find({ [field]: { $in: ids }, type: 'free' })
    .select(`${field} ticketsStaked`)
    .lean();
  const map = new Map();
  for (const p of preds) {
    const id = String(p[field]);
    const t = Math.max(1, parseInt(p.ticketsStaked, 10) || 1);
    map.set(id, (map.get(id) || 0) + t);
  }
  return map;
}

function displayJackpotPools(item) {
  const freeJackpot = item.isResolved
    ? (Number(item.originalFreeJackpotPool) || 0) + (Number(item.freeJackpotPool) || 0)
    : Number(item.freeJackpotPool) || 0;
  const boostJackpot = item.isResolved
    ? Math.max(Number(item.originalBoostPool) || 0, Number(item.boostPool) || 0)
    : Number(item.boostPool) || 0;
  return { freeJackpot, boostJackpot };
}

module.exports = {
  distributeFreeJackpotTopUp,
  distributeBoostPoolTopUp,
  getTicketTotalsByEvent,
  displayJackpotPools,
};
