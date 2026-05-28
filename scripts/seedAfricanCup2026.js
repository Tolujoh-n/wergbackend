const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const User = require('../models/User');
const Cup = require('../models/Cup');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Prediction = require('../models/Prediction');
const Settings = require('../models/Settings');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/wergame');

const seedData = async () => {
  try {
    console.log('🌱 Starting seed data creation...');

    // Delete existing African Cup 2026 data to avoid duplicates
    const existingCup = await Cup.findOne({ slug: 'african-cup-2026' });
    if (existingCup) {
      console.log('🗑️  Removing existing African Cup 2026 data...');
      // Get match and poll IDs before deleting
      const existingMatches = await Match.find({ cup: existingCup._id }).select('_id');
      const existingPolls = await Poll.find({ cup: existingCup._id }).select('_id');
      const matchIds = existingMatches.map(m => m._id);
      const pollIds = existingPolls.map(p => p._id);
      
      // Delete predictions first
      if (matchIds.length > 0 || pollIds.length > 0) {
        await Prediction.deleteMany({ 
          $or: [
            { match: { $in: matchIds } },
            { poll: { $in: pollIds } }
          ]
        });
      }
      // Then delete matches and polls
      await Match.deleteMany({ cup: existingCup._id });
      await Poll.deleteMany({ cup: existingCup._id });
      // Finally delete the cup
      await Cup.deleteOne({ _id: existingCup._id });
      console.log('✅ Existing data removed');
    }

    // Create or get Settings
    const pointsPerWinSetting = await Settings.findOneAndUpdate(
      { key: 'pointsPerWin' },
      { key: 'pointsPerWin', value: 10, description: 'Points awarded per winning prediction' },
      { upsert: true, new: true }
    );

    const dailyFreePlayLimit = await Settings.findOneAndUpdate(
      { key: 'dailyFreePlayLimit' },
      { key: 'dailyFreePlayLimit', value: 5, description: 'Daily free play limit' },
      { upsert: true, new: true }
    );

    // Create African Cup 2026 Cup (existing one was already deleted above if it existed)
    const africanCup = new Cup({
      name: 'African Cup of Nations 2026',
      slug: 'african-cup-2026',
      description: 'The 36th edition of the Africa Cup of Nations, hosted in Morocco',
      startDate: new Date('2026-01-10'),
      endDate: new Date('2026-02-08'),
      isActive: true,
      activeMatches: 0,
    });
    await africanCup.save();
    console.log('✅ Created Cup: African Cup of Nations 2026');

    // Create 10 test users
    const users = [];
    const userData = [
      { username: 'player1', email: 'player1@test.com', password: 'password123', walletAddress: '0x1111111111111111111111111111111111111111' },
      { username: 'player2', email: 'player2@test.com', password: 'password123', walletAddress: '0x2222222222222222222222222222222222222222' },
      { username: 'player3', email: 'player3@test.com', password: 'password123', walletAddress: '0x3333333333333333333333333333333333333333' },
      { username: 'player4', email: 'player4@test.com', password: 'password123', walletAddress: '0x4444444444444444444444444444444444444444' },
      { username: 'player5', email: 'player5@test.com', password: 'password123', walletAddress: '0x5555555555555555555555555555555555555555' },
      { username: 'player6', email: 'player6@test.com', password: 'password123', walletAddress: '0x6666666666666666666666666666666666666666' },
      { username: 'player7', email: 'player7@test.com', password: 'password123', walletAddress: '0x7777777777777777777777777777777777777777' },
      { username: 'player8', email: 'player8@test.com', password: 'password123', walletAddress: '0x8888888888888888888888888888888888888888' },
      { username: 'player9', email: 'player9@test.com', password: 'password123', walletAddress: '0x9999999999999999999999999999999999999999' },
      { username: 'player10', email: 'player10@test.com', password: 'password123', walletAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    ];

    for (const userInfo of userData) {
      // Check for existing user by email OR username to avoid duplicates
      let user = await User.findOne({ 
        $or: [
          { email: userInfo.email },
          { username: userInfo.username }
        ]
      });
      
      if (!user) {
        // Create new user - password will be hashed by User model's pre-save hook
        user = new User({
          username: userInfo.username,
          email: userInfo.email,
          password: userInfo.password, // Plain password - will be hashed by pre-save hook
          walletAddress: userInfo.walletAddress,
          tickets: 5,
          lastTicketDate: new Date(),
          points: 0,
          streak: 0,
          correctPredictions: 0,
          totalPredictions: 0,
        });
        await user.save();
        console.log(`   ✅ Created user: ${userInfo.email}`);
      } else {
        // Update existing user - reset stats and update password/wallet if needed
        user.username = userInfo.username;
        user.email = userInfo.email;
        user.walletAddress = userInfo.walletAddress;
        user.points = 0;
        user.streak = 0;
        user.correctPredictions = 0;
        user.totalPredictions = 0;
        user.tickets = 5;
        user.lastTicketDate = new Date();
        
        // Set plain password - pre-save hook will hash it
        // Mark password as modified to ensure the hook runs
        user.password = userInfo.password;
        user.markModified('password');
        await user.save();
        
        console.log(`   ♻️  Updated user: ${userInfo.email}`);
      }
      users.push(user);
    }
    console.log('✅ Created 10 test users');

    // Create Matches
    const matches = [];
    const matchData = [
      { teamA: 'Nigeria', teamB: 'Ghana', date: '2026-01-12', status: 'completed', isResolved: true, result: 'TeamA' },
      { teamA: 'Egypt', teamB: 'Senegal', date: '2026-01-13', status: 'completed', isResolved: true, result: 'TeamB' },
      { teamA: 'Morocco', teamB: 'Algeria', date: '2026-01-14', status: 'completed', isResolved: true, result: 'Draw' },
      { teamA: 'Cameroon', teamB: 'Ivory Coast', date: '2026-01-15', status: 'completed', isResolved: true, result: 'TeamA' },
      { teamA: 'Tunisia', teamB: 'Mali', date: '2026-01-16', status: 'completed', isResolved: true, result: 'TeamB' },
      { teamA: 'South Africa', teamB: 'Zambia', date: '2026-01-20', status: 'upcoming', isResolved: false },
      { teamA: 'Kenya', teamB: 'Uganda', date: '2026-01-21', status: 'upcoming', isResolved: false },
      { teamA: 'DR Congo', teamB: 'Angola', date: '2026-01-22', status: 'upcoming', isResolved: false },
    ];

    for (const matchInfo of matchData) {
      let match = await Match.findOne({ teamA: matchInfo.teamA, teamB: matchInfo.teamB, cup: africanCup._id });
      if (!match) {
        match = new Match({
          teamA: matchInfo.teamA,
          teamB: matchInfo.teamB,
          date: new Date(matchInfo.date),
          cup: africanCup._id,
          status: matchInfo.status,
          isResolved: matchInfo.isResolved || false,
          result: matchInfo.result || null,
          marketInitialized: true,
          marketTeamALiquidity: 100,
          marketTeamBLiquidity: 100,
          marketDrawLiquidity: 50,
          marketTeamAShares: 1000,
          marketTeamBShares: 1000,
          marketDrawShares: 500,
          freeJackpotPool: matchInfo.isResolved ? 0 : 2.5, // Keep pool if not resolved
          boostJackpotPool: matchInfo.isResolved ? 0 : 1.5,
          platformFees: 0.5,
        });
        await match.save();
      }
      matches.push(match);
    }
    console.log('✅ Created 8 matches');

    // Create Polls
    const polls = [];
    const pollData = [
      { question: 'Will Nigeria win the tournament?', type: 'team', status: 'settled', isResolved: true, result: 'YES' },
      { question: 'Will there be more than 50 goals in the group stage?', type: 'stage', status: 'settled', isResolved: true, result: 'NO' },
      { question: 'Will a North African team reach the final?', type: 'team', status: 'upcoming', isResolved: false },
      { question: 'Will the tournament have a penalty shootout in the final?', type: 'match', status: 'upcoming', isResolved: false },
    ];

    for (const pollInfo of pollData) {
      try {
        const poll = new Poll({
          question: pollInfo.question,
          description: `Poll for ${pollInfo.question}`,
          type: pollInfo.type,
          cup: africanCup._id,
          optionType: 'normal',
          status: pollInfo.status,
          isResolved: pollInfo.isResolved || false,
          result: pollInfo.result || null,
          marketInitialized: true,
          marketYesLiquidity: 80,
          marketNoLiquidity: 80,
          marketYesShares: 800,
          marketNoShares: 800,
          freeJackpotPool: pollInfo.isResolved ? 0 : 1.8, // Keep pool if not resolved
          boostJackpotPool: pollInfo.isResolved ? 0 : 1.2,
          platformFees: 0.4,
        });
        await poll.save();
        polls.push(poll);
        console.log(`   ✅ Created poll: ${pollInfo.question} (ID: ${poll._id})`);
      } catch (error) {
        console.error(`   ❌ Error creating poll "${pollInfo.question}":`, error.message);
        throw error;
      }
    }
    console.log('✅ Created 4 polls');
    
    // Verify polls were created
    if (polls.length === 0) {
      throw new Error('No polls were created!');
    }
    if (polls.length < 2) {
      throw new Error(`Only ${polls.length} polls were created, expected at least 2`);
    }
    console.log(`   ✅ Verified ${polls.length} polls created`);

    // Create Predictions with wins and losses
    const predictions = [];

    // Match 1: Nigeria vs Ghana (Nigeria won)
    // Player 1-3: Won (predicted Nigeria)
    // Player 4-5: Lost (predicted Ghana)
    // Player 6-7: Lost (predicted Draw)
    for (let i = 0; i < 3; i++) {
      // Free predictions - won
      const freePred = new Prediction({
        user: users[i]._id,
        match: matches[0]._id,
        type: 'free',
        outcome: 'TeamA', // Nigeria
        status: 'won',
      });
      await freePred.save();
      predictions.push(freePred);

      // Boost predictions - won
      const boostPred = new Prediction({
        user: users[i]._id,
        match: matches[0]._id,
        type: 'boost',
        outcome: 'TeamA',
        amount: 5 + i,
        totalStake: 5 + i,
        status: 'won',
        payout: (5 + i) * 1.5, // Won with payout
      });
      await boostPred.save();
      predictions.push(boostPred);

      // Market predictions - won
      const marketPred = new Prediction({
        user: users[i]._id,
        match: matches[0]._id,
        type: 'market',
        outcome: 'TEAMA',
        shares: 100 + (i * 10),
        totalInvested: 10 + i,
        status: 'won',
        payout: (10 + i) * 1.2,
      });
      await marketPred.save();
      predictions.push(marketPred);
    }

    for (let i = 3; i < 5; i++) {
      // Free predictions - lost
      const freePred = new Prediction({
        user: users[i]._id,
        match: matches[0]._id,
        type: 'free',
        outcome: 'TeamB', // Ghana
        status: 'lost',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    for (let i = 5; i < 7; i++) {
      // Free predictions - lost
      const freePred = new Prediction({
        user: users[i]._id,
        match: matches[0]._id,
        type: 'free',
        outcome: 'Draw',
        status: 'lost',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Match 2: Egypt vs Senegal (Senegal won)
    // Player 1, 3, 5: Won (predicted Senegal)
    // Player 2, 4, 6: Lost (predicted Egypt)
    const winners2 = [0, 2, 4];
    const losers2 = [1, 3, 5];
    for (const idx of winners2) {
      const freePred = new Prediction({
        user: users[idx]._id,
        match: matches[1]._id,
        type: 'free',
        outcome: 'TeamB', // Senegal
        status: 'won',
      });
      await freePred.save();
      predictions.push(freePred);
    }
    for (const idx of losers2) {
      const freePred = new Prediction({
        user: users[idx]._id,
        match: matches[1]._id,
        type: 'free',
        outcome: 'TeamA', // Egypt
        status: 'lost',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Match 3: Morocco vs Algeria (Draw)
    // Player 2, 4, 6: Won (predicted Draw)
    // Player 1, 3, 5: Lost
    const winners3 = [1, 3, 5];
    const losers3 = [0, 2, 4];
    for (const idx of winners3) {
      const freePred = new Prediction({
        user: users[idx]._id,
        match: matches[2]._id,
        type: 'free',
        outcome: 'Draw',
        status: 'won',
      });
      await freePred.save();
      predictions.push(freePred);
    }
    for (const idx of losers3) {
      const freePred = new Prediction({
        user: users[idx]._id,
        match: matches[2]._id,
        type: 'free',
        outcome: idx % 2 === 0 ? 'TeamA' : 'TeamB',
        status: 'lost',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Match 4: Cameroon vs Ivory Coast (Cameroon won)
    // Player 0, 1, 2: Won (predicted Cameroon)
    for (let i = 0; i < 3; i++) {
      const freePred = new Prediction({
        user: users[i]._id,
        match: matches[3]._id,
        type: 'free',
        outcome: 'TeamA', // Cameroon
        status: 'won',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Match 5: Tunisia vs Mali (Mali won)
    // Player 3, 4, 5: Won (predicted Mali)
    for (let i = 3; i < 6; i++) {
      const freePred = new Prediction({
        user: users[i]._id,
        match: matches[4]._id,
        type: 'free',
        outcome: 'TeamB', // Mali
        status: 'won',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Poll 1: Will Nigeria win the tournament? (YES - resolved)
    // Player 0, 2, 4, 6: Won (predicted YES)
    // Player 1, 3, 5: Lost (predicted NO)
    if (!polls[0] || !polls[0]._id) {
      console.error(`❌ Error: polls[0] is undefined or has no _id. Polls array length: ${polls.length}`);
      console.error(`   Polls:`, polls.map(p => p ? { id: p._id, question: p.question } : 'null'));
      throw new Error(`polls[0] is undefined! Polls array length: ${polls.length}`);
    }
    const pollWinners1 = [0, 2, 4, 6];
    const pollLosers1 = [1, 3, 5];
    for (const idx of pollWinners1) {
      const freePred = new Prediction({
        user: users[idx]._id,
        poll: polls[0]._id,
        type: 'free',
        outcome: 'YES',
        status: 'won',
      });
      await freePred.save();
      predictions.push(freePred);
    }
    for (const idx of pollLosers1) {
      const freePred = new Prediction({
        user: users[idx]._id,
        poll: polls[0]._id,
        type: 'free',
        outcome: 'NO',
        status: 'lost',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Poll 2: Will there be more than 50 goals? (NO - resolved)
    // Player 1, 3, 5, 7: Won (predicted NO)
    // Player 0, 2, 4: Lost (predicted YES)
    const pollWinners2 = [1, 3, 5, 7];
    const pollLosers2 = [0, 2, 4];
    for (const idx of pollWinners2) {
      const freePred = new Prediction({
        user: users[idx]._id,
        poll: polls[1]._id,
        type: 'free',
        outcome: 'NO',
        status: 'won',
      });
      await freePred.save();
      predictions.push(freePred);
    }
    for (const idx of pollLosers2) {
      const freePred = new Prediction({
        user: users[idx]._id,
        poll: polls[1]._id,
        type: 'free',
        outcome: 'YES',
        status: 'lost',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Add some pending predictions for unresolved matches/polls
    for (let i = 0; i < 10; i++) {
      const freePred = new Prediction({
        user: users[i]._id,
        match: matches[5]._id, // Upcoming match
        type: 'free',
        outcome: i % 3 === 0 ? 'TeamA' : (i % 3 === 1 ? 'TeamB' : 'Draw'),
        status: 'pending',
      });
      await freePred.save();
      predictions.push(freePred);
    }

    // Update user stats
    // Get pointsPerWin value (setting was already created/updated above)
    const pointsPerWinValue = await Settings.findOne({ key: 'pointsPerWin' });
    const pointsPerWin = pointsPerWinValue ? parseInt(pointsPerWinValue.value) : 10;
    
    for (const user of users) {
      const userPredictions = await Prediction.find({ user: user._id });
      const wonPredictions = userPredictions.filter(p => p.status === 'won');
      const freeWon = wonPredictions.filter(p => p.type === 'free').length;
      
      // Calculate points: free wins * pointsPerWin + boost/market payouts
      const boostPayouts = userPredictions
        .filter(p => p.type === 'boost' && p.status === 'won')
        .reduce((sum, p) => sum + (p.payout || 0), 0);
      const marketPayouts = userPredictions
        .filter(p => p.type === 'market' && p.status === 'won')
        .reduce((sum, p) => sum + (p.payout || 0), 0);
      
      user.points = (freeWon * pointsPerWin) + boostPayouts + marketPayouts;
      user.correctPredictions = wonPredictions.length;
      user.totalPredictions = userPredictions.length;
      
      // Calculate streak (consecutive wins from most recent)
      const sortedPredictions = userPredictions
        .filter(p => p.type === 'free')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      
      let streak = 0;
      for (const pred of sortedPredictions) {
        if (pred.status === 'won') {
          streak++;
        } else if (pred.status === 'lost') {
          break; // Streak broken
        }
      }
      user.streak = streak;
      
      await user.save();
    }

    console.log('✅ Created predictions and updated user stats');
    console.log('\n📊 Seed Data Summary:');
    console.log(`   - Cup: ${africanCup.name}`);
    console.log(`   - Users: ${users.length}`);
    console.log(`   - Matches: ${matches.length} (${matches.filter(m => m.isResolved).length} resolved)`);
    console.log(`   - Polls: ${polls.length} (${polls.filter(p => p.isResolved).length} resolved)`);
    console.log(`   - Predictions: ${predictions.length}`);
    console.log('\n👥 Test User Accounts (Password: password123):');
    users.forEach((user, idx) => {
      console.log(`   ${idx + 1}. ${user.email} (${user.username})`);
    });
    console.log('\n✅ Seed data creation completed!');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  }
};

seedData();
