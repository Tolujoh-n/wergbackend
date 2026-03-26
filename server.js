const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const cron = require('node-cron');

dotenv.config();

const { ethers } = require('ethers');
const { getClaimSignerAddress } = require('./utils/claimAuth');
const { router: ethPriceRouter, updateEthPrice } = require('./routes/ethPrice');

const app = express();

// Middleware
app.use(cors({
  origin: [
    'https://wergtest-enn.vercel.app',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/cups', require('./routes/cups'));
app.use('/api/matches', require('./routes/matches'));
app.use('/api/polls', require('./routes/polls'));
app.use('/api/predictions', require('./routes/predictions'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/superadmin', require('./routes/superadmin'));
app.use('/api/claims', require('./routes/claims'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/streaks', require('./routes/streaks'));
app.use('/api/jackpots', require('./routes/jackpots'));
app.use('/api/stages', require('./routes/stages'));
app.use('/api/blogs', require('./routes/blogs'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/eth-price', ethPriceRouter);

// Public chain/contract + claim signer address (no private keys)
app.get('/api/config/claim', (req, res) => {
  const raw = process.env.CONTRACT_ADDRESS || process.env.REACT_APP_CONTRACT_ADDRESS;
  let contractAddress = null;
  try {
    contractAddress = raw ? ethers.getAddress(raw) : null;
  } catch {
    contractAddress = raw || null;
  }
  res.json({
    contractAddress,
    chainId: parseInt(process.env.CHAIN_ID || '84532', 10),
    claimSignerAddress: getClaimSignerAddress(),
  });
});

const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI || '')
  .then(() => {
    console.log('MongoDB connected');
    updateEthPrice();
    cron.schedule('*/5 * * * *', async () => {
      console.log('Updating ETH price from CoinGecko...');
      await updateEthPrice();
    });
  })
  .catch((err) => console.error('MongoDB connection error:', err));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
