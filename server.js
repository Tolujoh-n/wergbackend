const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

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

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || '')
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
