require('dotenv').config();
const mongoose = require('mongoose');
const { getResolvedChainMarketIdSet } = require('../utils/resolvedMarkets');
const { orderbookContractAddressLower } = require('../utils/orderbookContractScope');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const current = orderbookContractAddressLower();
  const old = '0x05a675706187ad3eca82f1f56596eacfabfe4447';
  console.log('current contract', current);
  const curSet = await getResolvedChainMarketIdSet(current);
  const oldSet = await getResolvedChainMarketIdSet(old);
  console.log('resolved on CURRENT includes 19?', curSet.has(19), 'size', curSet.size);
  console.log('resolved on OLD includes 19?', oldSet.has(19), 'size', oldSet.size);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
