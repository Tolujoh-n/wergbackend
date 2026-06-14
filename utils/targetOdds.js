/** Normalize admin startingPrices so multi-outcome YES mids sum to 1 (target odds). */

const { normalizeStartingPriceVolumes } = require('./mmQuoteVolume');

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
      const total = Math.max(10, Number(row?.quoteVolumeUsdc) || 200);
      const half = total / 2;
      return {
        optionKey,
        yesPrice,
        noPrice,
        quoteVolumeUsdc: total,
        yesQuoteVolumeUsdc: Math.max(5, Number(row?.yesQuoteVolumeUsdc) || half),
        noQuoteVolumeUsdc: Math.max(5, Number(row?.noQuoteVolumeUsdc) || half),
      };
    })
    .filter(Boolean);

  if (out.length > 1) {
    const yesSum = out.reduce((s, r) => s + r.yesPrice, 0);
    if (yesSum > 0) {
      out = out.map((r) => {
        const yes = clampPrice(r.yesPrice / yesSum);
        const no = clampPrice(1 - yes);
        return { ...r, yesPrice: yes, noPrice: no };
      });
    }
  }

  return normalizeStartingPriceVolumes(out);
}

module.exports = { normalizeStartingPricesRows };
