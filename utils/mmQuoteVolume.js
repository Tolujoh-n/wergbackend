/** Per-outcome MM quote volume caps (USDC notional resting on the book). */

const DEFAULT_OPTION_QUOTE_VOLUME_USDC = 200;
const ROW_TARGET_USDC = 100;
const MAX_MM_LEVELS = 12;

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

/** Split a USDC budget into rows of up to ROW_TARGET_USDC (e.g. 300 → [100,100,100]). */
function splitNotionalsIntoRows(budgetUsdc) {
  const budget = Math.max(0, Number(budgetUsdc) || 0);
  if (budget <= 0.01) return [ROW_TARGET_USDC];
  const rows = [];
  let remaining = budget;
  while (remaining > 0.01 && rows.length < MAX_MM_LEVELS) {
    const chunk = Math.min(ROW_TARGET_USDC, remaining);
    rows.push(chunk);
    remaining = parseFloat((remaining - chunk).toFixed(6));
  }
  return rows.length ? rows : [Math.min(ROW_TARGET_USDC, budget || ROW_TARGET_USDC)];
}

/** How many bid or ask levels for one outcome side (half of side volume, ~100 USDC per row). */
function mmLevelCountForHalf(halfVolUsdc) {
  const half = Math.max(5, Number(halfVolUsdc) || 0);
  return Math.min(MAX_MM_LEVELS, Math.max(1, splitNotionalsIntoRows(half).length));
}

function mmLevelCountForSide(doc, optionKey, side, quoteMult = 1) {
  const sideVol = sideVolumeUsdc(doc, optionKey, side) * quoteMult;
  return mmLevelCountForHalf(sideVol / 2);
}

/** Build per-level share sizes for bids and asks (~100 USDC notional per row). */
function mmLevelSizesForSide(doc, optionKey, side, bids, asks, quoteMult = 1) {
  const sideVol = sideVolumeUsdc(doc, optionKey, side) * quoteMult;
  const bidNotionals = splitNotionalsIntoRows(sideVol / 2);
  const askNotionals = splitNotionalsIntoRows(sideVol / 2);
  const levelCount = Math.max(bidNotionals.length, askNotionals.length);

  const bidSizes = [];
  const askSizes = [];
  for (let i = 0; i < levelCount; i += 1) {
    const bidPx = bids[Math.min(i, (bids || []).length - 1)] ?? bids?.[0] ?? 0.5;
    const askPx = asks[Math.min(i, (asks || []).length - 1)] ?? asks?.[0] ?? 0.5;
    bidSizes.push(levelSizeFromNotional(bidNotionals[Math.min(i, bidNotionals.length - 1)], bidPx));
    askSizes.push(levelSizeFromNotional(askNotionals[Math.min(i, askNotionals.length - 1)], askPx));
  }

  return { bidSizes, askSizes, levelCount };
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
  ROW_TARGET_USDC,
  MAX_MM_LEVELS,
  quoteVolumeRow,
  sideVolumeUsdc,
  levelSizeFromNotional,
  splitNotionalsIntoRows,
  mmLevelCountForHalf,
  mmLevelCountForSide,
  mmLevelSizesForSide,
  normalizeStartingPriceVolumes,
};
