/**
 * Stabilize France-Spain (or any marketId):
 * 1) Pause bot so a remote/production MM cron cannot overwrite quotes
 * 2) Cancel all MM quotes
 * 3) Force-requote at admin startingPrices (preferTarget)
 *
 * Usage: node scripts/stabilizeMarketQuotes.js [marketId]
 * Re-enable bot later: node scripts/stabilizeMarketQuotes.js 19 --enable
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const mid = Number(process.argv[2] || 19);
  const enable = process.argv.includes('--enable');
  await mongoose.connect(process.env.MONGODB_URI);
  const Match = require('../models/Match');
  const Order = require('../models/Order');
  const {
    getMarketMakerActor,
    forceRequoteMarketMm,
    cancelAllMmQuotesForMarket,
  } = require('../services/marketMakerQuotes');
  const { getBook, impliedProbabilityByOption, depthWeightedMidFromBookSide } = require('../services/orderbookService');

  const doc = await Match.findOne({ marketId: mid, isResolved: { $ne: true } });
  if (!doc) {
    console.log('No active match for marketId', mid);
    await mongoose.disconnect();
    return;
  }

  if (enable) {
    doc.orderbook = { ...(doc.orderbook || {}), botEnabled: true };
    delete doc.orderbook.mmPreferTargetUntil;
    await doc.save();
    console.log('Bot re-enabled for', doc.teamA, 'vs', doc.teamB);
    await mongoose.disconnect();
    return;
  }

  console.log('Stabilizing', doc.teamA, 'vs', doc.teamB, 'marketId', mid);
  // Pause so any other server sharing this DB stops fighting us on live mid.
  doc.orderbook = {
    ...(doc.orderbook || {}),
    botEnabled: false,
    mmPreferTargetUntil: new Date(Date.now() + 10 * 60 * 1000),
  };
  await doc.save();
  console.log('botEnabled=false (remote maintenance will skip this market)');

  const actor = await getMarketMakerActor();
  if (!actor) {
    console.log('No MM actor');
    await mongoose.disconnect();
    return;
  }
  await cancelAllMmQuotesForMarket(mid, String(actor.walletAddress).toLowerCase());
  const r = await forceRequoteMarketMm(doc, 'match');
  console.log('forceRequote', r);

  // Keep bot paused after quote so remote cron cannot wipe target prices until you deploy + --enable.
  await Match.updateOne(
    { _id: doc._id },
    {
      $set: {
        'orderbook.botEnabled': false,
        'orderbook.mmPreferTargetUntil': new Date(Date.now() + 10 * 60 * 1000),
      },
    }
  );

  const keys = ['TeamA', 'TeamB'];
  if (doc.drawEnabled !== false) keys.splice(1, 0, 'Draw');
  const implied = await impliedProbabilityByOption(mid, keys, doc.startingPrices);
  console.log('implied', implied, 'sum', Object.values(implied).reduce((a, b) => a + b, 0));

  for (const optionKey of keys) {
    for (const side of ['YES', 'NO']) {
      const book = await getBook(mid, optionKey, side);
      const m = depthWeightedMidFromBookSide(book.bids, book.asks, 3);
      const bb = book.bids[0]?.limitPrice;
      const ba = book.asks[0]?.limitPrice;
      const crossed = bb != null && ba != null && Number(bb) >= Number(ba);
      console.log(optionKey, side, { mid: m, bb, ba, crossed });
    }
  }

  const open = await Order.find({
    chainMarketId: mid,
    walletAddress: String(actor.walletAddress).toLowerCase(),
    status: { $in: ['open', 'partially_filled'] },
  })
    .select('optionKey side direction limitPrice sizeRemaining')
    .lean();
  console.log('open MM quotes:');
  for (const o of open) {
    console.log(o.optionKey, o.side, o.direction, o.limitPrice, o.sizeRemaining);
  }
  console.log('\nBot remains paused. After deploying backend fixes, run:');
  console.log(`  node scripts/stabilizeMarketQuotes.js ${mid} --enable`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
