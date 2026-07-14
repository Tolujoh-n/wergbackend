require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Match = require('../models/Match');
const { resolveQuoteMid, getMarketMakerActor } = require('../services/marketMakerQuotes');
const { depthWeightedMidFromBookSide, getBook } = require('../services/orderbookService');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const wl = '0x7db1a56732836e8623e594810a13c799966bd33c';
  const c = '0xf45e84635a2f7196eeef062d9e22013fad762144';
  const mid = 19;

  const doc = await Match.findOne({ marketId: mid, isResolved: { $ne: true } });
  console.log('active match', doc?.teamA, doc?.teamB, 'starting', doc?.startingPrices);

  const rows = await Order.find({
    chainMarketId: mid,
    walletAddress: wl,
    contractAddress: c,
    status: { $in: ['open', 'partially_filled'] },
  })
    .select('optionKey side direction limitPrice sizeRemaining isMarketMaker updatedAt')
    .sort({ optionKey: 1, side: 1, direction: 1, limitPrice: -1 })
    .lean();

  console.log('MM open count', rows.length);
  for (const r of rows) {
    console.log(
      r.optionKey,
      r.side,
      r.direction,
      r.limitPrice,
      r.sizeRemaining,
      'mm=',
      r.isMarketMaker,
      r.updatedAt
    );
  }

  const actor = await getMarketMakerActor();
  for (const optionKey of ['TeamA', 'TeamB']) {
    for (const side of ['YES', 'NO']) {
      const target = await resolveQuoteMid({
        doc,
        optionKey,
        side,
        chainMarketId: mid,
        mmWalletLower: wl,
        preferTarget: true,
      });
      const live = await resolveQuoteMid({
        doc,
        optionKey,
        side,
        chainMarketId: mid,
        mmWalletLower: wl,
        preferTarget: false,
      });
      const book = await getBook(mid, optionKey, side);
      const dw = depthWeightedMidFromBookSide(book.bids, book.asks, 3);
      console.log(optionKey, side, { preferTarget: target, liveMid: live, bookMid: dw });
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
