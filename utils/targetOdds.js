/** Normalize admin startingPrices so multi-outcome YES mids sum to 1 (target odds). */

function clampPrice(n) {
  return Math.max(0.01, Math.min(0.99, Number(n) || 0.5));
}

function normalizeStartingPricesRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];

  let out = rows
    .map((row) => {
      const optionKey = String(row?.optionKey || '').trim();
      if (!optionKey) return null;
      const yesPrice = clampPrice(row?.yesPrice);
      const noPrice = clampPrice(row?.noPrice ?? 1 - yesPrice);
      if (yesPrice + noPrice > 1.0001) {
        const err = new Error(`YES + NO prices for "${optionKey}" must sum to at most 1`);
        err.statusCode = 400;
        throw err;
      }
      return { optionKey, yesPrice, noPrice };
    })
    .filter(Boolean);

  if (out.length > 1) {
    const yesSum = out.reduce((s, r) => s + r.yesPrice, 0);
    if (yesSum > 0) {
      out = out.map((r) => {
        const yes = clampPrice(r.yesPrice / yesSum);
        const no = clampPrice(1 - yes);
        return { optionKey: r.optionKey, yesPrice: yes, noPrice: no };
      });
    }
  }

  return out;
}

module.exports = { normalizeStartingPricesRows };
