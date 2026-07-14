require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Match = require('../models/Match');
  const Order = require('../models/Order');
  const { impliedProbabilityByOption, getBook } = require('../services/orderbookService');
  const { midFromBookSide } = require('../services/orderbookService');

  const france = await Match.find({
    $or: [
      { teamA: /france/i },
      { teamB: /france/i },
      { teamA: /spain/i },
      { teamB: /spain/i },
    ],
  })
    .select('teamA teamB marketId isResolved status drawEnabled startingPrices')
    .lean();
  console.log('matches', JSON.stringify(france, null, 2));

  for (const m of france) {
    if (m.marketId == null) continue;
    const keys = ['TeamA'];
    if (m.drawEnabled !== false) keys.push('Draw');
    keys.push('TeamB');
    console.log('\n===', m.teamA, 'vs', m.teamB, 'marketId', m.marketId, 'resolved', m.isResolved);
    const implied = await impliedProbabilityByOption(m.marketId, keys, m.startingPrices || []);
    console.log('impliedNow', implied);
    for (const opt of keys) {
      for (const side of ['YES', 'NO']) {
        const book = await getBook(m.marketId, opt, side);
        const bb = book.bids.slice(0, 3).map((b) => `${b.limitPrice}@${b.sizeRemaining}${b.isMarketMaker ? 'MM' : ''}`);
        const ba = book.asks.slice(0, 3).map((a) => `${a.limitPrice}@${a.sizeRemaining}${a.isMarketMaker ? 'MM' : ''}`);
        const mid = midFromBookSide(book.bids, book.asks);
        console.log(opt, side, 'mid', mid, 'bids', bb, 'asks', ba);
      }
    }
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
