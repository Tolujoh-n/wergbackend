const Order = require('../models/Order');
const OrderbookFill = require('../models/OrderbookFill');
const { withOrderbookContract } = require('../utils/orderbookContractScope');

/**
 * Persist each runMatch leg at its execution price (maker limit).
 */
async function persistOrderbookFills({ fills, takerOrder, touched, session = null }) {
  if (!fills?.length || !takerOrder) return;
  const makerById = new Map((touched || []).map((m) => [String(m._id), m]));
  const baseMs = Date.now();
  const docs = fills.map((f, idx) => {
    const maker = makerById.get(String(f.makerId));
    return {
      contractAddress: takerOrder.contractAddress,
      chainMarketId: takerOrder.chainMarketId,
      match: takerOrder.match || undefined,
      poll: takerOrder.poll || undefined,
      optionKey: takerOrder.optionKey,
      side: takerOrder.side,
      price: Number(f.tradePx),
      size: Number(f.tradeSize),
      notional: Number(f.notional) || 0,
      takerDirection: takerOrder.direction,
      takerOrderId: takerOrder._id,
      makerOrderId: f.makerId,
      takerIsMarketMaker: !!takerOrder.isMarketMaker,
      makerIsMarketMaker: !!maker?.isMarketMaker,
      filledAt: new Date(baseMs + idx),
    };
  });
  await OrderbookFill.insertMany(docs, session ? { session } : undefined);
}

/**
 * Chart tape from execution fills; falls back to legacy order rows when no fills exist yet.
 */
async function getOrderbookTradeTape(chainMarketId, limit = 400) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 400));
  const fills = await OrderbookFill.find(withOrderbookContract({ chainMarketId }))
    .sort({ filledAt: 1 })
    .limit(cap)
    .select('optionKey side price size takerDirection takerIsMarketMaker makerIsMarketMaker filledAt')
    .lean();

  if (fills.length > 0) {
    return fills.map((f) => ({
      t: f.filledAt,
      optionKey: String(f.optionKey || ''),
      side: f.side,
      price: Number(f.price) || 0,
      size: Number(f.size) || 0,
      direction: f.takerDirection,
      isMarketMaker: !!(f.takerIsMarketMaker || f.makerIsMarketMaker),
      source: 'fill',
    }));
  }

  const orders = await Order.find({
    ...withOrderbookContract({ chainMarketId }),
    sizeFilled: { $gt: 0 },
  })
    .sort({ updatedAt: 1 })
    .limit(cap)
    .select('optionKey side limitPrice sizeFilled updatedAt createdAt direction isMarketMaker')
    .lean();

  return orders.map((o) => ({
    t: o.updatedAt || o.createdAt,
    optionKey: String(o.optionKey || ''),
    side: o.side,
    price: Number(o.limitPrice) || 0,
    size: Number(o.sizeFilled) || 0,
    direction: o.direction,
    isMarketMaker: !!o.isMarketMaker,
    source: 'order_legacy',
  }));
}

module.exports = {
  persistOrderbookFills,
  getOrderbookTradeTape,
};
