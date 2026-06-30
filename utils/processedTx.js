const mongoose = require('mongoose');

/**
 * Atomic idempotency guard for on-chain actions.
 *
 * A unique compound index on (scope, txHash) lets MongoDB reject duplicate
 * processing of the same transaction at the database level — immune to the
 * check-then-act race that lets an RPC timeout + user retry credit/claim twice.
 */
const processedTxSchema = new mongoose.Schema({
  scope: { type: String, required: true },
  txHash: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  predictionId: { type: String },
  amount: { type: Number },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});

processedTxSchema.index({ scope: 1, txHash: 1 }, { unique: true });

const ProcessedTx =
  mongoose.models.ProcessedTx || mongoose.model('ProcessedTx', processedTxSchema);

function normalizeHash(txHash) {
  return String(txHash || '').trim().toLowerCase();
}

/**
 * Try to reserve a (scope, txHash) pair.
 * @returns {Promise<{ reserved: boolean, doc: object|null }>}
 *   reserved=true  → this caller won the race and may proceed to credit.
 *   reserved=false → already processed; doc holds the prior record (or null).
 */
async function reserveTx(scope, txHash, extra = {}) {
  const key = normalizeHash(txHash);
  if (!key) return { reserved: false, doc: null, invalid: true };
  try {
    const doc = await ProcessedTx.create({ scope, txHash: key, ...extra });
    return { reserved: true, doc };
  } catch (e) {
    if (e && e.code === 11000) {
      const doc = await ProcessedTx.findOne({ scope, txHash: key }).lean();
      return { reserved: false, doc };
    }
    throw e;
  }
}

/** Attach the resulting record id (e.g. predictionId) after a successful credit. */
async function finalizeTx(scope, txHash, update = {}) {
  const key = normalizeHash(txHash);
  if (!key) return;
  await ProcessedTx.updateOne({ scope, txHash: key }, { $set: update });
}

/** Roll back a reservation if the credit failed, so the user can retry. */
async function releaseTx(scope, txHash) {
  const key = normalizeHash(txHash);
  if (!key) return;
  await ProcessedTx.deleteOne({ scope, txHash: key });
}

module.exports = {
  ProcessedTx,
  reserveTx,
  finalizeTx,
  releaseTx,
  normalizeHash,
};
