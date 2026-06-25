function normalizeMatchOutcome(outcome, teamA, teamB, drawEnabled = true) {
  if (!outcome || typeof outcome !== 'string') return null;
  const raw = String(outcome).trim();
  const lower = raw.toLowerCase();
  const teamALower = (teamA || '').trim().toLowerCase();
  const teamBLower = (teamB || '').trim().toLowerCase();
  if (lower === 'teama' || (teamALower && lower === teamALower)) return 'TeamA';
  if (lower === 'teamb' || (teamBLower && lower === teamBLower)) return 'TeamB';
  if (lower === 'draw') return drawEnabled !== false ? 'Draw' : null;
  return null;
}

function normalizeBoostOutcomeForItem(outcome, item, isMatch) {
  const raw = String(outcome || '').trim();
  if (!raw || !item) return raw;
  if (isMatch) {
    const normalized = normalizeMatchOutcome(raw, item.teamA, item.teamB, item.drawEnabled);
    return normalized || raw;
  }
  if (item.optionType === 'options' && Array.isArray(item.options) && item.options.length > 0) {
    const hit = item.options.find(
      (opt) => String(opt?.text || '').trim().toLowerCase() === raw.toLowerCase()
    );
    if (hit) return String(hit.text).trim();
    return raw;
  }
  const up = raw.toUpperCase();
  if (up === 'YES' || up === 'NO') return up;
  return raw;
}

function boostOutcomeKey(outcome, item, isMatch) {
  return normalizeBoostOutcomeForItem(outcome, item, isMatch);
}

function netBoostStake(pred) {
  const stake = Number(pred?.totalStake ?? pred?.amount ?? 0);
  return Number.isFinite(stake) && stake > 0 ? stake : 0;
}

function findBoostPredictionByOutcome(predictions, outcomeHint, item, isMatch) {
  const list = Array.isArray(predictions) ? predictions : [];
  if (!list.length || !outcomeHint) return null;
  const hintKey = boostOutcomeKey(outcomeHint, item, isMatch);
  return list.find((p) => boostOutcomeKey(p.outcome, item, isMatch) === hintKey) || null;
}

/** Normalize outcomes and stakes; merge duplicate outcome rows for API responses. */
async function serializeBoostPredictions(predictions, item, isMatch, { repair = false } = {}) {
  const byKey = new Map();

  for (const pred of predictions) {
    const key = boostOutcomeKey(pred.outcome, item, isMatch);
    const stake = netBoostStake(pred);
    const bucket = byKey.get(key);
    if (!bucket) {
      byKey.set(key, { preds: [pred], stake });
    } else {
      bucket.preds.push(pred);
      bucket.stake += stake;
    }
  }

  const out = [];
  for (const [key, { preds, stake }] of byKey.entries()) {
    const primary = preds.reduce((best, p) => {
      if (!best) return p;
      const bestT = new Date(best.updatedAt || best.createdAt || 0).getTime();
      const curT = new Date(p.updatedAt || p.createdAt || 0).getTime();
      return curT >= bestT ? p : best;
    }, null);

    if (repair) {
      for (const p of preds) {
        let dirty = false;
        const normalized = key;
        if (String(p.outcome) !== normalized) {
          p.outcome = normalized;
          dirty = true;
        }
        if (dirty) {
          p.updatedAt = new Date();
          await p.save();
        }
      }
      if (primary && stake > 0) {
        const cur = netBoostStake(primary);
        if (Math.abs(cur - stake) > 0.0001 || preds.length > 1) {
          primary.totalStake = stake;
          primary.amount = stake;
          primary.updatedAt = new Date();
          await primary.save();
        }
        for (let i = 1; i < preds.length; i += 1) {
          if (String(preds[i]._id) !== String(primary._id)) {
            await preds[i].deleteOne();
          }
        }
      }
    }

    const doc = primary.toObject ? primary.toObject() : { ...primary };
    doc.outcome = key;
    doc.totalStake = stake;
    doc.amount = stake;
    out.push(doc);
  }

  return out.sort(
    (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
  );
}

module.exports = {
  normalizeMatchOutcome,
  normalizeBoostOutcomeForItem,
  boostOutcomeKey,
  netBoostStake,
  findBoostPredictionByOutcome,
  serializeBoostPredictions,
};
