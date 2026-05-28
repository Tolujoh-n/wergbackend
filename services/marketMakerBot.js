const { expireStaleOrders } = require('./orderbookService');
const { ensureAllActiveMarketsQuotes } = require('./marketMakerQuotes');

/**
 * Expire stale orders + top up MM quotes on active markets (idempotent).
 */
async function marketMakerMaintenanceOnce() {
  await expireStaleOrders();
  try {
    const r = await ensureAllActiveMarketsQuotes();
    if (r.ordersPlaced > 0 || r.ordersAbsorbed > 0) {
      console.log('[marketMakerBot] maintenance', r);
    }
  } catch (e) {
    console.error('[marketMakerBot] ensureAllActiveMarketsQuotes', e.message || e);
  }
}

module.exports = { marketMakerMaintenanceOnce };
