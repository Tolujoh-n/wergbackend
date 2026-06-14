/** Per-outcome MM quote volume caps (USDC notional resting on the book). */

const DEFAULT_OPTION_QUOTE_VOLUME_USDC = 200;
const LEVELS = 3;

function quoteVolumeRow(doc, optionKey) {
  const row = (doc?.startingPrices || []).find((r) => String(r.optionKey) === String(optionKey));
  const total = Math.max(10, Number(row?.quoteVolumeUsdc) || DEFAULT_OPTION_QUOTE_VOLUME_USDC);
  const half = total / 2;
  const yesVol = Math.max(5, Number(row?.yesQuoteVolumeUsdc) || half);
  const noVol = Math.max(5, Number(row?.noQuoteVolumeUsdc) || half);
  return { total, yesVol, noVol };
}

function sideVolumeUsdc(doc, optionKey, side) {
  const { yesVol, noVol } = quoteVolumeRow(doc, optionKey);
  return String(side) === 'NO' ? noVol : yesVol;
}

function levelSizeFromNotional(notionalUsdc, price) {
  const p = Math.max(0.01, Math.min(0.99, Number(price) || 0.5));
  const n = Math.max(0, Number(notionalUsdc) || 0);
  return Math.max(0.01, Math.round((n / p) * 100) / 100);
}

/** Split side volume: half on bids, half on asks, each across LEVELS orders. */
function mmLevelSizesForSide(doc, optionKey, side, bids, asks, quoteMult = 1) {
  const sideVol = sideVolumeUsdc(doc, optionKey, side) * quoteMult;
  const bidNotional = (sideVol / 2) / LEVELS;
  const askNotional = (sideVol / 2) / LEVELS;
  return {
    bidSizes: (bids || []).slice(0, LEVELS).map((px) => levelSizeFromNotional(bidNotional, px)),
    askSizes: (asks || []).slice(0, LEVELS).map((px) => levelSizeFromNotional(askNotional, px)),
  };
}

function normalizeStartingPriceVolumes(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const total = Math.max(10, Number(row?.quoteVolumeUsdc) || DEFAULT_OPTION_QUOTE_VOLUME_USDC);
    const half = total / 2;
    return {
      ...row,
      quoteVolumeUsdc: total,
      yesQuoteVolumeUsdc: Math.max(5, Number(row?.yesQuoteVolumeUsdc) || half),
      noQuoteVolumeUsdc: Math.max(5, Number(row?.noQuoteVolumeUsdc) || half),
    };
  });
}

module.exports = {
  DEFAULT_OPTION_QUOTE_VOLUME_USDC,
  LEVELS,
  quoteVolumeRow,
  sideVolumeUsdc,
  levelSizeFromNotional,
  mmLevelSizesForSide,
  normalizeStartingPriceVolumes,
};
