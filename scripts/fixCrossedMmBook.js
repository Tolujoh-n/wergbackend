/**
 * Cancel crossed / stuck MM quotes on a chain market and force-requote at admin targets.
 * Usage: node scripts/fixCrossedMmBook.js [marketId]
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const mid = Number(process.argv[2] || 19);
  await mongoose.connect(process.env.MONGODB_URI);
  const Match = require('../models/Match');
  const Order = require('../models/Order');
  const {
    getMarketMakerActor,
    forceRequoteMarketMm,
  } = require('../services/marketMakerQuotes');
  const { getBook, impliedProbabilityByOption, depthWeightedMidFromBookSide } = require('../services/orderbookService');

  const doc = await Match.findOne({ marketId: mid, isResolved: { $ne: true } });
  if (!doc) {
    console.log('No active match for marketId', mid);
    await mongoose.disconnect();
    return;
  }
  console.log('Requoting', doc.teamA, 'vs', doc.teamB, 'marketId', mid);
  console.log('startingPrices', JSON.stringify(doc.startingPrices, null, 2));
  const actor = await getMarketMakerActor();
  console.log('MM', actor?.walletAddress);

  const r = await forceRequoteMarketMm(doc, 'match');
  console.log('forceRequote', r);

  const keys = ['TeamA', 'TeamB'];
  if (doc.drawEnabled !== false) keys.splice(1, 0, 'Draw');
  const implied = await impliedProbabilityByOption(mid, keys, doc.startingPrices);
  console.log('implied (sum≈1)', implied, 'sum', Object.values(implied).reduce((a, b) => a + b, 0));

  for (const optionKey of keys) {
    for (const side of ['YES', 'NO']) {
      const book = await getBook(mid, optionKey, side);
      const m = depthWeightedMidFromBookSide(book.bids, book.asks, 3);
      const bb = book.bids[0]?.limitPrice;
      const ba = book.asks[0]?.limitPrice;
      const crossed = bb != null && ba != null && bb >= ba;
      console.log(
        optionKey,
        side,
        'mid',
        m,
        'bb',
        bb,
        'ba',
        ba,
        crossed ? 'CROSSED' : 'ok',
        'bids',
        (book.bids || []).slice(0, 3).map((x) => `${x.limitPrice}@${x.sizeRemaining}`),
        'asks',
        (book.asks || []).slice(0, 3).map((x) => `${x.limitPrice}@${x.sizeRemaining}`)
      );
    }
  }

  const openMm = await Order.countDocuments({
    chainMarketId: mid,
    walletAddress: String(actor.walletAddress).toLowerCase(),
    isMarketMaker: true,
    status: { $in: ['open', 'partially_filled'] },
  });
  console.log('open MM orders after', openMm);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
