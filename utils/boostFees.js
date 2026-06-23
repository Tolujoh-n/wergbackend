/**
 * Boost stake fee split — jackpot slice credits event freeJackpotPool.
 * Uses freeJackpotFee from Super Admin (default 5%).
 */

const DEFAULT_FREE_JACKPOT_FEE_PCT = 5;

function getBoostFreeJackpotFeePct(fees) {
  const free = Number(fees?.freeJackpotFee);
  if (Number.isFinite(free) && free >= 0) return free;
  const legacy = Number(fees?.boostJackpotFee);
  if (Number.isFinite(legacy) && legacy >= 0) return legacy;
  return DEFAULT_FREE_JACKPOT_FEE_PCT;
}

function splitBoostStakeGross(grossAmount, fees) {
  const gross = Math.max(0, Number(grossAmount) || 0);
  const platformFeePct = Number(fees?.platformFee) ?? 10;
  const jackpotFeePct = getBoostFreeJackpotFeePct(fees);
  const platformFeeAmount = (gross * platformFeePct) / 100;
  const jackpotFeeAmount = (gross * jackpotFeePct) / 100;
  const netStakeAmount = Math.max(0, gross - platformFeeAmount - jackpotFeeAmount);
  return {
    gross,
    platformFeePct,
    jackpotFeePct,
    platformFeeAmount,
    jackpotFeeAmount,
    netStakeAmount,
  };
}

function applyBoostStakeToEvent(item, split) {
  item.boostPool = (item.boostPool || 0) + split.netStakeAmount;
  item.freeJackpotPool = (item.freeJackpotPool || 0) + split.jackpotFeeAmount;
  item.platformFees = (item.platformFees || 0) + split.platformFeeAmount;
}

/** Ensure on-chain net stake matches admin fee settings (contract fees must be synced). */
function validateVerifiedBoostNet(split, verifiedNetUsdc, tolerance = 0.02) {
  const verified = Number(verifiedNetUsdc);
  if (!Number.isFinite(verified)) return { ok: true };
  const diff = Math.abs(verified - split.netStakeAmount);
  if (diff <= tolerance) return { ok: true };
  return {
    ok: false,
    reason:
      `On-chain net stake ($${verified.toFixed(2)}) does not match expected $${split.netStakeAmount.toFixed(2)} ` +
      `after ${split.platformFeePct}% platform + ${split.jackpotFeePct}% free jackpot fees. ` +
      'Open Super Admin → Fees, click Set Fees to sync the contract.',
  };
}

function txHashRegex(txHash) {
  const txKey = String(txHash || '').trim().toLowerCase();
  if (!txKey) return null;
  const escaped = txKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}

module.exports = {
  DEFAULT_FREE_JACKPOT_FEE_PCT,
  getBoostFreeJackpotFeePct,
  splitBoostStakeGross,
  applyBoostStakeToEvent,
  validateVerifiedBoostNet,
  txHashRegex,
};
