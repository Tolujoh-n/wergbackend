/**
 * Backfill referral status for rows created before pending/verified flow.
 * Rows with goldenTicketsAwarded > 0 → verified; others → pending.
 *
 * Usage: node scripts/migrateReferrals.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Referral = require('../models/Referral');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const withoutStatus = await Referral.find({
    $or: [{ status: { $exists: false } }, { status: null }],
  });

  let verified = 0;
  let pending = 0;
  for (const r of withoutStatus) {
    const tickets = Number(r.goldenTicketsAwarded) || 0;
    if (tickets > 0) {
      r.status = 'verified';
      if (!r.verifiedAt) r.verifiedAt = r.createdAt || new Date();
      verified += 1;
    } else {
      r.status = 'pending';
      pending += 1;
    }
    await r.save();
  }

  console.log(`Migrated ${withoutStatus.length} referral(s): ${verified} verified, ${pending} pending`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
