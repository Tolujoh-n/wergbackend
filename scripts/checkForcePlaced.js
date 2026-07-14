require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Match = require('../models/Match');
const { resolveCoherentMids, getMarketMakerActor } = require('../services/marketMakerQuotes');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const ids = [
    '6a564ab8c61f6d75de773da6',
    '6a564ac2c61f6d75de773ddd',
    '6a564acdc61f6d75de773e1e',
    '6a564ad8c61f6d75de773e57',
    '6a564ae1c61f6d75de773e97',
    '6a564ae7c61f6d75de773ed0',
    '6a564af2c61f6d75de773f10',
    '6a564af9c61f6d75de773f49',
  ];
  const rows = await Order.find({ _id: { $in: ids } }).lean();
  for (const r of rows) {
    console.log({
      id: String(r._id),
      optionKey: r.optionKey,
      side: r.side,
      dir: r.direction,
      px: r.limitPrice,
      status: r.status,
      sz: r.sizeRemaining,
      mm: r.isMarketMaker,
    });
  }

  const open = await Order.find({
    chainMarketId: 19,
    walletAddress: '0x7db1a56732836e8623e594810a13c799966bd33c',
    status: { $in: ['open', 'partially_filled'] },
  })
    .select('optionKey side direction limitPrice sizeRemaining status createdAt')
    .lean();
  console.log('\nALL open MM on 19:');
  for (const r of open) {
    console.log(r.optionKey, r.side, r.direction, r.limitPrice, r.sizeRemaining, String(r._id));
  }

  const doc = await Match.findOne({ marketId: 19, isResolved: { $ne: true } });
  const actor = await getMarketMakerActor();
  const mids = await resolveCoherentMids({
    doc,
    optionKeys: ['TeamA', 'TeamB'],
    chainMarketId: 19,
    mmWalletLower: actor.walletAddress,
    preferTarget: true,
  });
  console.log('coherent preferTarget', mids);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
