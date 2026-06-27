/**
 * Auto-lock helpers: an event (match/poll) becomes locked for users once the
 * admin-scheduled lockedTime is reached, even though the on-chain status is not
 * yet flipped to "locked". The admin can later set the real locked status (tx).
 */

/** True once the scheduled lock time has passed. */
function isEventLockedByTime(item, now = Date.now()) {
  if (!item || !item.lockedTime) return false;
  const t = new Date(item.lockedTime).getTime();
  if (!Number.isFinite(t)) return false;
  return now >= t;
}

/**
 * Whether predictions/trades are still allowed.
 * Closed when resolved, admin status locked/settled/ended, or lock time reached.
 */
function isEventOpenForPlay(item, now = Date.now()) {
  if (!item) return false;
  if (item.isResolved === true) return false;
  const s = String(item.status || '').toLowerCase().trim();
  if (s === 'locked' || s === 'settled' || s === 'ended') return false;
  if (isEventLockedByTime(item, now)) return false;
  return true;
}

module.exports = { isEventLockedByTime, isEventOpenForPlay };
