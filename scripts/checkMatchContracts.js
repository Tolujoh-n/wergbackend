require('dotenv').config();
const mongoose = require('mongoose');
const Match = require('../models/Match');
const Poll = require('../models/Poll');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const rows = await Match.find({ marketId: 19 })
    .select('teamA teamB marketId contractAddress isResolved status')
    .lean();
  console.log('marketId 19 matches:', rows);

  const withC = await Match.countDocuments({
    marketId: { $ne: null },
    contractAddress: { $exists: true, $nin: [null, ''] },
  });
  const missing = await Match.countDocuments({
    marketId: { $ne: null },
    $or: [{ contractAddress: null }, { contractAddress: { $exists: false } }, { contractAddress: '' }],
  });
  console.log({ matchesWithContract: withC, matchesMissingContract: missing });

  const pollMissing = await Poll.countDocuments({
    marketId: { $ne: null },
    $or: [{ contractAddress: null }, { contractAddress: { $exists: false } }, { contractAddress: '' }],
  });
  console.log({ pollsMissingContract: pollMissing });
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
