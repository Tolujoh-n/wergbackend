/**
 * Engagement streaks: login (daily), free (per distinct event/day), boost (per distinct event/day).
 * Total streak = login + free + boost current counts (stored on User.streak for leaderboard).
 */

function utcDayKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

function dayDiffUtc(fromDay, toDay) {
  if (!fromDay || !toDay) return null;
  const a = new Date(`${fromDay}T00:00:00.000Z`).getTime();
  const b = new Date(`${toDay}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86400000);
}

function defaultBucket() {
  return { current: 0, best: 0, lastDay: null };
}

function ensureEngagementStreaks(user) {
  if (!user.engagementStreaks || typeof user.engagementStreaks !== 'object') {
    user.engagementStreaks = {};
  }
  for (const key of ['login', 'free', 'boost']) {
    if (!user.engagementStreaks[key]) {
      user.engagementStreaks[key] = defaultBucket();
    }
  }
  return user.engagementStreaks;
}

function applyDecay(bucket, today) {
  const b = bucket || defaultBucket();
  if (!b.lastDay) return { ...b };
  const gap = dayDiffUtc(b.lastDay, today);
  if (gap != null && gap > 1) {
    return { ...b, current: 0 };
  }
  return { ...b };
}

function syncTotalStreak(user) {
  const e = ensureEngagementStreaks(user);
  const today = utcDayKey();
  const login = applyDecay(e.login, today);
  const free = applyDecay(e.free, today);
  const boost = applyDecay(e.boost, today);
  user.streak = (login.current || 0) + (free.current || 0) + (boost.current || 0);
  return user.streak;
}

function incrementActivityBucket(bucket, today) {
  const b = applyDecay(bucket || defaultBucket(), today);
  const gap = b.lastDay ? dayDiffUtc(b.lastDay, today) : null;

  if (!b.lastDay || gap > 1) {
    b.current = 1;
  } else if (gap === 1 || gap === 0) {
    b.current = (b.current || 0) + 1;
  } else {
    b.current = 1;
  }

  b.lastDay = today;
  b.best = Math.max(b.best || 0, b.current || 0);
  return b;
}

function recordLoginStreak(user) {
  ensureEngagementStreaks(user);
  const today = utcDayKey();
  const login = applyDecay(user.engagementStreaks.login, today);
  if (login.lastDay === today) {
    user.engagementStreaks.login = login;
    syncTotalStreak(user);
    return user;
  }
  user.engagementStreaks.login = incrementActivityBucket(login, today);
  syncTotalStreak(user);
  return user;
}

function recordFreePredictionStreak(user) {
  ensureEngagementStreaks(user);
  const today = utcDayKey();
  user.engagementStreaks.free = incrementActivityBucket(
    applyDecay(user.engagementStreaks.free, today),
    today
  );
  syncTotalStreak(user);
  return user;
}

function recordBoostPredictionStreak(user) {
  ensureEngagementStreaks(user);
  const today = utcDayKey();
  user.engagementStreaks.boost = incrementActivityBucket(
    applyDecay(user.engagementStreaks.boost, today),
    today
  );
  syncTotalStreak(user);
  return user;
}

function getEngagementStreakPayload(user) {
  ensureEngagementStreaks(user);
  const today = utcDayKey();
  const login = applyDecay(user.engagementStreaks.login, today);
  const free = applyDecay(user.engagementStreaks.free, today);
  const boost = applyDecay(user.engagementStreaks.boost, today);
  const totalCurrent = (login.current || 0) + (free.current || 0) + (boost.current || 0);
  const totalBest = (login.best || 0) + (free.best || 0) + (boost.best || 0);

  return {
    totalStreak: totalCurrent,
    currentStreak: totalCurrent,
    longestStreak: totalBest,
    bestStreak: totalBest,
    login: {
      current: login.current || 0,
      best: login.best || 0,
      lastDay: login.lastDay,
    },
    free: {
      current: free.current || 0,
      best: free.best || 0,
      lastDay: free.lastDay,
    },
    boost: {
      current: boost.current || 0,
      best: boost.best || 0,
      lastDay: boost.lastDay,
    },
  };
}

module.exports = {
  utcDayKey,
  ensureEngagementStreaks,
  recordLoginStreak,
  recordFreePredictionStreak,
  recordBoostPredictionStreak,
  getEngagementStreakPayload,
  syncTotalStreak,
  applyDecay,
};
