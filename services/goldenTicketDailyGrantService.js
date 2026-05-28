const GoldenTicketDailyGrant = require('../models/GoldenTicketDailyGrant');
const User = require('../models/User');
const { resolveUserByIdentifier } = require('../utils/resolveUserByIdentifier');
const { awardGoldenTickets } = require('./ticketService');

function startOfUtcDay(d = new Date()) {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

function addUtcDays(dayStart, n) {
  const t = new Date(dayStart);
  t.setUTCDate(t.getUTCDate() + n);
  return t;
}

function utcDayKey(d) {
  return startOfUtcDay(d).getTime();
}

/**
 * Grant today's tickets if this schedule is due (idempotent per UTC day).
 */
async function processGrantRow(grant) {
  if (!grant?.active) return { granted: 0 };
  const now = Date.now();
  if (grant.endDate && new Date(grant.endDate).getTime() < now) {
    grant.active = false;
    await grant.save();
    return { granted: 0, completed: true };
  }
  if ((grant.daysGranted || 0) >= (grant.daysTotal || 0)) {
    grant.active = false;
    await grant.save();
    return { granted: 0, completed: true };
  }

  const today = startOfUtcDay();
  const lastKey = grant.lastGrantedUtcDay ? utcDayKey(grant.lastGrantedUtcDay) : null;
  const todayKey = utcDayKey(today);
  if (lastKey != null && lastKey >= todayKey) {
    return { granted: 0, alreadyToday: true };
  }

  const qty = Math.max(1, parseInt(grant.ticketsPerDay, 10) || 1);
  await awardGoldenTickets(grant.user, qty);

  grant.daysGranted = (grant.daysGranted || 0) + 1;
  grant.lastGrantedUtcDay = today;
  if (grant.daysGranted >= grant.daysTotal) {
    grant.active = false;
  }
  await grant.save();
  return { granted: qty };
}

async function processGrantsForUser(userId) {
  if (!userId) return { totalGranted: 0 };
  const grants = await GoldenTicketDailyGrant.find({ user: userId, active: true });
  let totalGranted = 0;
  for (const g of grants) {
    const r = await processGrantRow(g);
    totalGranted += r.granted || 0;
  }
  return { totalGranted };
}

async function processAllDueGoldenTicketGrants() {
  const grants = await GoldenTicketDailyGrant.find({ active: true }).limit(500);
  let usersTouched = 0;
  let ticketsGranted = 0;
  for (const g of grants) {
    const before = g.daysGranted;
    const r = await processGrantRow(g);
    if (r.granted > 0) {
      usersTouched += 1;
      ticketsGranted += r.granted;
    } else if (g.daysGranted !== before) {
      usersTouched += 1;
    }
  }
  return { usersTouched, ticketsGranted, scanned: grants.length };
}

/**
 * Schedule N days of daily golden tickets (grants first day immediately).
 */
async function createDailyGoldenTicketGrant({
  email,
  walletAddress,
  identifier,
  ticketsPerDay,
  days,
  createdBy,
  note,
}) {
  const qty = Math.max(1, parseInt(ticketsPerDay, 10) || 0);
  const dayCount = Math.max(1, parseInt(days, 10) || 0);
  if (qty <= 0 || dayCount <= 0) {
    const err = new Error('ticketsPerDay and days must be positive');
    err.statusCode = 400;
    throw err;
  }

  const user = await resolveUserByIdentifier({ email, walletAddress, identifier });
  if (!user) {
    const err = new Error('User not found for that email or wallet');
    err.statusCode = 404;
    throw err;
  }

  const start = startOfUtcDay();
  const end = addUtcDays(start, dayCount);

  const grant = await GoldenTicketDailyGrant.create({
    user: user._id,
    ticketsPerDay: qty,
    daysTotal: dayCount,
    daysGranted: 0,
    startDate: start,
    endDate: end,
    active: true,
    createdBy: createdBy || null,
    recipientEmail: user.email || (email && String(email).includes('@') ? String(email).trim() : ''),
    recipientWallet: walletAddress ? String(walletAddress).trim().toLowerCase() : '',
    note: note || '',
  });

  const first = await processGrantRow(grant);
  const refreshed = await GoldenTicketDailyGrant.findById(grant._id).lean();
  const userAfter = await User.findById(user._id).select('goldenTickets email username');

  return {
    grant: refreshed,
    firstGrantTickets: first.granted || 0,
    user: userAfter,
    message: `Scheduled ${qty} golden ticket(s) per day for ${dayCount} day(s). First grant applied: ${first.granted || 0}.`,
  };
}

async function listActiveGrants(limit = 50) {
  return GoldenTicketDailyGrant.find({ active: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('user', 'username email')
    .lean();
}

async function cancelGrant(grantId) {
  const g = await GoldenTicketDailyGrant.findByIdAndUpdate(
    grantId,
    { $set: { active: false } },
    { new: true }
  );
  if (!g) {
    const err = new Error('Grant schedule not found');
    err.statusCode = 404;
    throw err;
  }
  return g;
}

module.exports = {
  createDailyGoldenTicketGrant,
  processGrantsForUser,
  processAllDueGoldenTicketGrants,
  listActiveGrants,
  cancelGrant,
  startOfUtcDay,
};
