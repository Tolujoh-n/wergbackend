const Prediction = require('../models/Prediction');
const OrderbookPosition = require('../models/OrderbookPosition');
const WalletLink = require('../models/WalletLink');
const { withOrderbookContract } = require('../utils/orderbookContractScope');

/**
 * Polymarket-style: for winning contract outcome W, YES(W) wins and NO(X) wins for all X !== W.
 * @param {string[]} optionKeys - Contract option strings (e.g. TeamA, TeamB, Draw or poll option texts)
 * @param {string} winningOptionKey - Resolved winning option (same encoding as chain)
 */
function winningPositionKeys(optionKeys, winningOptionKey) {
  const set = new Set();
  for (const key of optionKeys) {
    if (key === winningOptionKey) {
      set.add(`${key}|YES`);
    } else {
      set.add(`${key}|NO`);
    }
  }
  return [...set];
}

/**
 * After admin resolve: create `Prediction` rows for orderbook winners so claim-auth + UI work like AMM.
 * @param {object} params
 * @param {import('mongoose').Document} params.item - Match or Poll (resolved)
 * @param {'match'|'poll'} params.kind
 * @param {string} params.winningOptionKey - TeamA | TeamB | Draw | poll option text
 */
function roundPayoutUsdc(shares) {
  const s = Number(shares) || 0;
  if (!(s > 0)) return 0;
  return Math.round(s * 100) / 100;
}

async function createOrderbookResolutionPredictions({ item, kind, winningOptionKey }) {
  const marketId = item.marketId;
  if (marketId == null) return;

  let optionKeys;
  let winKey = winningOptionKey;
  if (kind === 'match') {
    optionKeys = ['TeamA', 'TeamB', 'Draw'];
  } else if (item.optionType === 'options' && item.options?.length) {
    optionKeys = item.options.map((o) => String(o.text || '').trim()).filter(Boolean);
  } else {
    optionKeys = ['YES', 'NO'];
    winKey = String(winningOptionKey || '').toUpperCase();
  }

  const winKeys = new Set(winningPositionKeys(optionKeys, winKey));

  const positions = await OrderbookPosition.find(
    withOrderbookContract({
      chainMarketId: marketId,
      shares: { $gt: 1e-9 },
    })
  ).lean();

  const winners = positions.filter((p) => winKeys.has(p.positionKey));
  if (winners.length === 0) {
    return;
  }

  for (const pos of winners) {
    const payout = roundPayoutUsdc(pos.shares);
    if (!(payout > 0)) continue;

    const wallet = pos.walletAddress;
    const link = await WalletLink.findOne({ walletAddress: wallet }).lean();
    if (!link) continue;

    const filter = {
      user: link.user,
      type: 'market',
      marketChannel: 'orderbook',
      outcome: pos.positionKey,
    };
    if (kind === 'match') filter.match = item._id;
    else filter.poll = item._id;

    await Prediction.findOneAndUpdate(
      filter,
      {
        $set: {
          walletAddress: wallet,
          shares: pos.shares,
          totalInvested: pos.totalInvested || 0,
          payout,
          status: 'settled',
          claimed: false,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }
}

module.exports = {
  winningPositionKeys,
  createOrderbookResolutionPredictions,
};
