const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Cup = require('../models/Cup');
const Stage = require('../models/Stage');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Prediction = require('../models/Prediction');
const Blog = require('../models/Blog');

const seedData = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/wergame');
    console.log('Connected to MongoDB');

    // Clear existing data
    await User.deleteMany({});
    await Cup.deleteMany({});
    await Stage.deleteMany({});
    await Match.deleteMany({});
    await Poll.deleteMany({});
    await Prediction.deleteMany({});
    await Blog.deleteMany({});
    console.log('Cleared existing data');

    // Create Users with various stats
    const users = [];
    const userData = [
      { username: 'admin', email: 'admin@wergame.com', password: 'admin123', role: 'admin', points: 1000, streak: 5, correctPredictions: 45, totalPredictions: 60 },
      { username: 'superadmin', email: 'superadmin@wergame.com', password: 'superadmin123', role: 'superAdmin', points: 2000, streak: 10, correctPredictions: 80, totalPredictions: 100 },
      { username: 'testuser', email: 'test@wergame.com', password: 'test123', role: 'user', points: 500, streak: 3, correctPredictions: 25, totalPredictions: 40, tickets: 1 },
      { username: 'player1', email: 'player1@wergame.com', password: 'player1', role: 'user', points: 750, streak: 7, correctPredictions: 35, totalPredictions: 50 },
      { username: 'player2', email: 'player2@wergame.com', password: 'player2', role: 'user', points: 600, streak: 5, correctPredictions: 30, totalPredictions: 45 },
      { username: 'player3', email: 'player3@wergame.com', password: 'player3', role: 'user', points: 450, streak: 4, correctPredictions: 20, totalPredictions: 35 },
      { username: 'player4', email: 'player4@wergame.com', password: 'player4', role: 'user', points: 300, streak: 2, correctPredictions: 15, totalPredictions: 30 },
      { username: 'player5', email: 'player5@wergame.com', password: 'player5', role: 'user', points: 200, streak: 1, correctPredictions: 10, totalPredictions: 25 },
    ];

    for (const userInfo of userData) {
      const user = new User(userInfo);
      await user.save();
      users.push(user);
    }

    console.log('Created users');

    // Get admin user for blog author
    const adminUser = users.find(u => u.role === 'admin') || users[0];

    // Create Cups
    const worldCup = new Cup({
      name: 'FIFA World Cup 2024',
      slug: 'worldcup',
      description: 'The biggest football tournament in the world',
      status: 'active',
      startDate: new Date('2024-06-14'),
      endDate: new Date('2024-07-15'),
    });
    await worldCup.save();

    const championsLeague = new Cup({
      name: 'UEFA Champions League 2024',
      slug: 'championsleague',
      description: 'Europe\'s premier club competition',
      status: 'active',
      startDate: new Date('2024-09-17'),
      endDate: new Date('2025-06-01'),
    });
    await championsLeague.save();

    const premierLeague = new Cup({
      name: 'Premier League 2024/25',
      slug: 'premierleague',
      description: 'English top-flight football',
      status: 'active',
      startDate: new Date('2024-08-17'),
      endDate: new Date('2025-05-25'),
    });
    await premierLeague.save();

    const laliga = new Cup({
      name: 'La Liga 2024/25',
      slug: 'laliga',
      description: 'Spanish top-flight football',
      status: 'active',
      startDate: new Date('2024-08-18'),
      endDate: new Date('2025-05-26'),
    });
    await laliga.save();

    const bundesliga = new Cup({
      name: 'Bundesliga 2024/25',
      slug: 'bundesliga',
      description: 'German top-flight football',
      status: 'active',
      startDate: new Date('2024-08-16'),
      endDate: new Date('2025-05-24'),
    });
    await bundesliga.save();

    console.log('Created cups');

    // Create Stages for World Cup
    const groupStage = new Stage({
      name: 'Group Stage',
      cup: worldCup._id,
      order: 1,
      startDate: new Date('2024-06-14'),
      endDate: new Date('2024-06-28'),
    });
    await groupStage.save();

    const roundOf16 = new Stage({
      name: 'Round of 16',
      cup: worldCup._id,
      order: 2,
      startDate: new Date('2024-06-29'),
      endDate: new Date('2024-07-03'),
    });
    await roundOf16.save();

    const quarterFinals = new Stage({
      name: 'Quarter Finals',
      cup: worldCup._id,
      order: 3,
      startDate: new Date('2024-07-04'),
      endDate: new Date('2024-07-06'),
    });
    await quarterFinals.save();

    const semiFinals = new Stage({
      name: 'Semi Finals',
      cup: worldCup._id,
      order: 4,
      startDate: new Date('2024-07-09'),
      endDate: new Date('2024-07-10'),
    });
    await semiFinals.save();

    const final = new Stage({
      name: 'Final',
      cup: worldCup._id,
      order: 5,
      startDate: new Date('2024-07-14'),
      endDate: new Date('2024-07-14'),
    });
    await final.save();

    // Create Stages for Champions League
    const clGroupStage = new Stage({
      name: 'Group Stage',
      cup: championsLeague._id,
      order: 1,
      startDate: new Date('2024-09-17'),
      endDate: new Date('2024-12-11'),
    });
    await clGroupStage.save();

    const clRoundOf16 = new Stage({
      name: 'Round of 16',
      cup: championsLeague._id,
      order: 2,
      startDate: new Date('2025-02-11'),
      endDate: new Date('2025-03-12'),
    });
    await clRoundOf16.save();

    const clQuarterFinals = new Stage({
      name: 'Quarter Finals',
      cup: championsLeague._id,
      order: 3,
      startDate: new Date('2025-04-08'),
      endDate: new Date('2025-04-16'),
    });
    await clQuarterFinals.save();

    const clSemiFinals = new Stage({
      name: 'Semi Finals',
      cup: championsLeague._id,
      order: 4,
      startDate: new Date('2025-04-29'),
      endDate: new Date('2025-05-07'),
    });
    await clSemiFinals.save();

    const clFinal = new Stage({
      name: 'Final',
      cup: championsLeague._id,
      order: 5,
      startDate: new Date('2025-05-31'),
      endDate: new Date('2025-05-31'),
    });
    await clFinal.save();

    // Create Stages for Premier League
    const plFirstHalf = new Stage({
      name: 'First Half of Season',
      cup: premierLeague._id,
      order: 1,
      startDate: new Date('2024-08-17'),
      endDate: new Date('2024-12-28'),
    });
    await plFirstHalf.save();

    const plSecondHalf = new Stage({
      name: 'Second Half of Season',
      cup: premierLeague._id,
      order: 2,
      startDate: new Date('2025-01-11'),
      endDate: new Date('2025-05-25'),
    });
    await plSecondHalf.save();

    // Create Stages for La Liga
    const laligaFirstHalf = new Stage({
      name: 'First Half of Season',
      cup: laliga._id,
      order: 1,
      startDate: new Date('2024-08-18'),
      endDate: new Date('2024-12-22'),
    });
    await laligaFirstHalf.save();

    const laligaSecondHalf = new Stage({
      name: 'Second Half of Season',
      cup: laliga._id,
      order: 2,
      startDate: new Date('2025-01-05'),
      endDate: new Date('2025-05-26'),
    });
    await laligaSecondHalf.save();

    // Create Stages for Bundesliga
    const bundesligaFirstHalf = new Stage({
      name: 'First Half of Season',
      cup: bundesliga._id,
      order: 1,
      startDate: new Date('2024-08-16'),
      endDate: new Date('2024-12-21'),
    });
    await bundesligaFirstHalf.save();

    const bundesligaSecondHalf = new Stage({
      name: 'Second Half of Season',
      cup: bundesliga._id,
      order: 2,
      startDate: new Date('2025-01-10'),
      endDate: new Date('2025-05-24'),
    });
    await bundesligaSecondHalf.save();

    console.log('Created stages');

    // Create Matches with market liquidity - World Cup matches
    const matchData = [
      {
        teamA: 'Brazil',
        teamB: 'Germany',
        date: new Date('2024-06-20T15:00:00Z'),
        cup: worldCup._id,
        stage: groupStage._id,
        stageName: 'Group Stage',
        status: 'upcoming',
        freePredictions: 150,
        boostPool: 2.5,
        marketInitialized: true,
        marketYesLiquidity: 5.0,
        marketNoLiquidity: 5.0,
        marketYesShares: 100,
        marketNoShares: 100,
        isFeatured: true,
      },
      {
        teamA: 'Argentina',
        teamB: 'France',
        date: new Date('2024-06-22T18:00:00Z'),
        cup: worldCup._id,
        stage: groupStage._id,
        stageName: 'Group Stage',
        status: 'upcoming',
        freePredictions: 200,
        boostPool: 3.2,
        marketInitialized: true,
        marketYesLiquidity: 6.5,
        marketNoLiquidity: 6.5,
        marketYesShares: 130,
        marketNoShares: 130,
        isFeatured: true,
      },
      {
        teamA: 'Spain',
        teamB: 'Italy',
        date: new Date('2024-06-24T16:00:00Z'),
        cup: worldCup._id,
        stage: groupStage._id,
        stageName: 'Group Stage',
        status: 'live',
        freePredictions: 180,
        boostPool: 2.8,
        marketInitialized: true,
        marketYesLiquidity: 4.2,
        marketNoLiquidity: 4.2,
        marketYesShares: 84,
        marketNoShares: 84,
        isFeatured: false,
      },
      {
        teamA: 'England',
        teamB: 'Netherlands',
        date: new Date('2024-07-01T19:00:00Z'),
        cup: worldCup._id,
        stage: roundOf16._id,
        stageName: 'Round of 16',
        status: 'upcoming',
        freePredictions: 120,
        boostPool: 4.5,
        marketInitialized: true,
        marketYesLiquidity: 8.0,
        marketNoLiquidity: 8.0,
        marketYesShares: 160,
        marketNoShares: 160,
        isFeatured: false,
      },
      {
        teamA: 'Portugal',
        teamB: 'Belgium',
        date: new Date('2024-07-05T20:00:00Z'),
        cup: worldCup._id,
        stage: quarterFinals._id,
        stageName: 'Quarter Finals',
        status: 'upcoming',
        freePredictions: 100,
        boostPool: 5.2,
        marketInitialized: true,
        marketYesLiquidity: 10.0,
        marketNoLiquidity: 10.0,
        marketYesShares: 200,
        marketNoShares: 200,
        isFeatured: true,
      },
      {
        teamA: 'Brazil',
        teamB: 'Argentina',
        date: new Date('2024-07-09T21:00:00Z'),
        cup: worldCup._id,
        stage: semiFinals._id,
        stageName: 'Semi Finals',
        status: 'upcoming',
        freePredictions: 250,
        boostPool: 8.5,
        marketInitialized: true,
        marketYesLiquidity: 15.0,
        marketNoLiquidity: 15.0,
        marketYesShares: 300,
        marketNoShares: 300,
        isFeatured: true,
      },
      // More matches for different stages
      {
        teamA: 'France',
        teamB: 'Spain',
        date: new Date('2024-06-25T16:00:00Z'),
        cup: worldCup._id,
        stage: groupStage._id,
        stageName: 'Group Stage',
        status: 'upcoming',
        freePredictions: 140,
        boostPool: 2.2,
        marketInitialized: true,
        marketYesLiquidity: 4.0,
        marketNoLiquidity: 4.0,
        marketYesShares: 80,
        marketNoShares: 80,
        isFeatured: false,
      },
      {
        teamA: 'Germany',
        teamB: 'Netherlands',
        date: new Date('2024-07-02T18:00:00Z'),
        cup: worldCup._id,
        stage: roundOf16._id,
        stageName: 'Round of 16',
        status: 'upcoming',
        freePredictions: 110,
        boostPool: 4.0,
        marketInitialized: true,
        marketYesLiquidity: 7.5,
        marketNoLiquidity: 7.5,
        marketYesShares: 150,
        marketNoShares: 150,
        isFeatured: false,
      },
      {
        teamA: 'Portugal',
        teamB: 'Spain',
        date: new Date('2024-07-06T20:00:00Z'),
        cup: worldCup._id,
        stage: quarterFinals._id,
        stageName: 'Quarter Finals',
        status: 'upcoming',
        freePredictions: 95,
        boostPool: 5.0,
        marketInitialized: true,
        marketYesLiquidity: 9.0,
        marketNoLiquidity: 9.0,
        marketYesShares: 180,
        marketNoShares: 180,
        isFeatured: true,
      },
    ];

    const createdMatches = [];
    for (const data of matchData) {
      const match = new Match(data);
      await match.save();
      createdMatches.push(match);
    }

    // Create completed matches with results
    const completedMatches = [
      {
        teamA: 'France',
        teamB: 'Croatia',
        date: new Date('2024-06-18T17:00:00Z'),
        cup: worldCup._id,
        stage: groupStage._id,
        stageName: 'Group Stage',
        status: 'completed',
        result: 'France',
        isResolved: true,
        freePredictions: 300,
        boostPool: 6.5,
        marketInitialized: true,
        marketYesLiquidity: 7.0,
        marketNoLiquidity: 3.0,
        marketYesShares: 140,
        marketNoShares: 60,
      },
      {
        teamA: 'England',
        teamB: 'Sweden',
        date: new Date('2024-06-19T14:00:00Z'),
        cup: worldCup._id,
        stage: groupStage._id,
        stageName: 'Group Stage',
        status: 'completed',
        result: 'Draw',
        isResolved: true,
        freePredictions: 180,
        boostPool: 3.8,
        marketInitialized: true,
        marketYesLiquidity: 4.5,
        marketNoLiquidity: 4.5,
        marketYesShares: 90,
        marketNoShares: 90,
      },
    ];

    for (const data of completedMatches) {
      const match = new Match(data);
      await match.save();
      createdMatches.push(match);
    }

    console.log('Created matches');

    // Create Polls with market liquidity
    const pollData = [
      {
        question: 'Will Brazil win the World Cup?',
        description: 'Predict if Brazil will be crowned champions',
        type: 'team',
        cup: worldCup._id,
        status: 'active',
        marketInitialized: true,
        marketYesLiquidity: 12.0,
        marketNoLiquidity: 8.0,
        marketYesShares: 240,
        marketNoShares: 160,
        isFeatured: true,
      },
      {
        question: 'Will Argentina reach the Quarter Finals?',
        description: 'Can Argentina make it to the last 8?',
        type: 'stage',
        cup: worldCup._id,
        stage: quarterFinals._id,
        status: 'active',
        marketInitialized: true,
        marketYesLiquidity: 6.0,
        marketNoLiquidity: 4.0,
        marketYesShares: 120,
        marketNoShares: 80,
        isFeatured: false,
      },
      {
        question: 'Who will be the top scorer?',
        description: 'Predict the tournament\'s golden boot winner',
        type: 'award',
        cup: worldCup._id,
        status: 'active',
        marketInitialized: true,
        marketYesLiquidity: 5.0,
        marketNoLiquidity: 5.0,
        marketYesShares: 100,
        marketNoShares: 100,
        isFeatured: true,
      },
      {
        question: 'Will there be a penalty shootout in the final?',
        description: 'Will the final be decided by penalties?',
        type: 'match',
        cup: worldCup._id,
        stage: final._id,
        status: 'active',
        marketInitialized: true,
        marketYesLiquidity: 3.0,
        marketNoLiquidity: 7.0,
        marketYesShares: 60,
        marketNoShares: 140,
        isFeatured: false,
      },
    ];

    const createdPolls = [];
    for (const data of pollData) {
      const poll = new Poll(data);
      await poll.save();
      createdPolls.push(poll);
    }

    console.log('Created polls');

    // Create Predictions - Free, Boost, and Market
    const predictions = [];

    // Free predictions - create more with won status
    for (let i = 0; i < 20; i++) {
      const match = createdMatches[i % createdMatches.length];
      const user = users[Math.floor(Math.random() * (users.length - 2)) + 2]; // Random user (not admin)
      const outcomes = [match.teamA, 'Draw', match.teamB];
      const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];
      
      // For completed matches, make some predictions correct
      let status = 'pending';
      if (match.isResolved) {
        status = match.result === outcome ? 'won' : 'lost';
      } else {
        // Randomly assign some as won for testing
        status = Math.random() > 0.4 ? 'won' : 'pending';
      }
      
      const prediction = new Prediction({
        user: user._id,
        match: match._id,
        type: 'free',
        outcome,
        status,
      });
      await prediction.save();
      predictions.push(prediction);
      
      // Update user stats
      const userDoc = await User.findById(user._id);
      if (status === 'won') {
        userDoc.correctPredictions = (userDoc.correctPredictions || 0) + 1;
        userDoc.points = (userDoc.points || 0) + 10;
        userDoc.streak = (userDoc.streak || 0) + 1;
      }
      userDoc.totalPredictions = (userDoc.totalPredictions || 0) + 1;
      await userDoc.save();
    }

    // Boost predictions
    for (let i = 0; i < 15; i++) {
      const match = createdMatches[i % createdMatches.length];
      const user = users[Math.floor(Math.random() * (users.length - 2)) + 2];
      const outcomes = [match.teamA, 'Draw', match.teamB];
      const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];
      const amount = 0.05 + Math.random() * 0.15; // Random amount between 0.05 and 0.2 ETH
      
      let status = 'pending';
      let payout = 0;
      if (match.isResolved) {
        status = match.result === outcome ? 'won' : 'lost';
        if (status === 'won') {
          // Calculate payout (simplified)
          payout = amount * 1.5; // Example payout
        }
      } else {
        // Randomly assign some as won for testing
        if (Math.random() > 0.5) {
          status = 'won';
          payout = amount * 1.5;
        }
      }

      const prediction = new Prediction({
        user: user._id,
        match: match._id,
        type: 'boost',
        outcome,
        amount,
        status,
        payout,
      });
      await prediction.save();
      predictions.push(prediction);
    }

    // Market predictions (for market type)
    for (let i = 0; i < 20; i++) {
      const match = createdMatches[i % createdMatches.length];
      const user = users[Math.floor(Math.random() * (users.length - 2)) + 2];
      const outcome = Math.random() > 0.5 ? match.teamA : match.teamB;
      const amount = 0.1 + Math.random() * 0.3;

      const prediction = new Prediction({
        user: user._id,
        match: match._id,
        type: 'market',
        outcome,
        amount,
        status: 'pending',
      });
      await prediction.save();
      predictions.push(prediction);
    }

    console.log('Created predictions');

    // Create Blogs
    const blogData = [
      {
        title: 'World Cup 2024: Top Teams to Watch',
        slug: 'world-cup-2024-top-teams-to-watch',
        description: 'A comprehensive analysis of the top contenders for the 2024 World Cup and what makes them special.',
        content: [
          {
            type: 'paragraph',
            children: [{ text: 'The 2024 World Cup promises to be one of the most exciting tournaments in recent history. With powerhouse teams from around the globe competing for the ultimate prize, fans are in for a treat.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Brazil: The Samba Kings' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'Brazil enters the tournament as one of the favorites, boasting a squad filled with talent and experience. Their attacking prowess and technical ability make them a formidable opponent.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Argentina: Defending Champions' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'After their triumph in 2022, Argentina will be looking to defend their title. With Lionel Messi leading the charge, they remain a force to be reckoned with.' }],
          },
        ],
        thumbnail: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=800',
        author: adminUser._id,
        category: 'Tournament',
        tags: ['World Cup', 'Football', 'Tournament'],
        isFeatured: true,
        isPublished: true,
        publishedAt: new Date('2024-06-01'),
        views: 1250,
        likes: [users[2]._id, users[3]._id, users[4]._id],
        comments: [
          {
            user: users[2]._id,
            content: 'Great analysis! Brazil looks really strong this year.',
            createdAt: new Date('2024-06-02'),
          },
        ],
      },
      {
        title: 'Understanding Market Predictions: A Beginner\'s Guide',
        slug: 'understanding-market-predictions-beginners-guide',
        description: 'Learn how to navigate the market prediction system on WeRgame and make informed trading decisions.',
        content: [
          {
            type: 'paragraph',
            children: [{ text: 'Market predictions on WeRgame allow you to trade shares of match outcomes, similar to a prediction market. Here\'s everything you need to know to get started.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'How Market Predictions Work' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'When you buy YES shares, you\'re betting that a specific outcome will happen. NO shares mean you think it won\'t happen. Prices fluctuate based on supply and demand.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Key Strategies' }],
          },
          {
            type: 'bulleted-list',
            children: [
              {
                type: 'list-item',
                children: [{ text: 'Buy low, sell high - enter early when prices are favorable' }],
              },
              {
                type: 'list-item',
                children: [{ text: 'Diversify your portfolio across multiple matches' }],
              },
              {
                type: 'list-item',
                children: [{ text: 'Monitor market sentiment and adjust your positions' }],
              },
            ],
          },
        ],
        thumbnail: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800',
        author: adminUser._id,
        category: 'Tutorial',
        tags: ['Market', 'Trading', 'Guide'],
        isFeatured: true,
        isPublished: true,
        publishedAt: new Date('2024-05-25'),
        views: 890,
        likes: [users[3]._id, users[4]._id],
        comments: [],
      },
      {
        title: 'Building Your Streak: Tips for Consistent Predictions',
        slug: 'building-your-streak-tips-for-consistent-predictions',
        description: 'Discover proven strategies to build and maintain winning streaks in your predictions.',
        content: [
          {
            type: 'paragraph',
            children: [{ text: 'Building a winning streak requires more than just luck. Here are some expert tips to help you make consistent, accurate predictions.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Research is Key' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'Before making any prediction, research team form, head-to-head records, injuries, and recent performances. Knowledge is your best weapon.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Start with Free Predictions' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'Use your daily free ticket to practice and build confidence. Once you\'re comfortable, you can move to boost predictions for bigger rewards.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Stay Consistent' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'Make predictions regularly to maintain your streak. Even one missed day can reset your progress, so stay engaged!' }],
          },
        ],
        thumbnail: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800',
        author: adminUser._id,
        category: 'Tips',
        tags: ['Streaks', 'Strategy', 'Tips'],
        isFeatured: true,
        isPublished: true,
        publishedAt: new Date('2024-05-20'),
        views: 1100,
        likes: [users[2]._id, users[3]._id, users[4]._id, users[5]._id],
        comments: [
          {
            user: users[3]._id,
            content: 'These tips really helped me improve my streak!',
            createdAt: new Date('2024-05-21'),
          },
          {
            user: users[4]._id,
            content: 'Great advice, especially about starting with free predictions.',
            createdAt: new Date('2024-05-22'),
          },
        ],
      },
      {
        title: 'Champions League Quarter Finals Preview',
        slug: 'champions-league-quarter-finals-preview',
        description: 'A detailed look at the upcoming Champions League quarter-final matches and key players to watch.',
        content: [
          {
            type: 'paragraph',
            children: [{ text: 'The Champions League has reached its most exciting stage. Eight teams remain, each with dreams of European glory.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Key Matchups' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'This round features some mouth-watering clashes between Europe\'s elite clubs. Expect tactical battles and moments of brilliance.' }],
          },
        ],
        thumbnail: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=800',
        author: adminUser._id,
        category: 'Tournament',
        tags: ['Champions League', 'Football'],
        isFeatured: false,
        isPublished: true,
        publishedAt: new Date('2024-04-10'),
        views: 650,
        likes: [users[2]._id],
        comments: [],
      },
      {
        title: 'Jackpot Strategies: Maximizing Your Chances',
        slug: 'jackpot-strategies-maximizing-your-chances',
        description: 'Learn how to increase your eligibility and chances of winning jackpots on WeRgame.',
        content: [
          {
            type: 'paragraph',
            children: [{ text: 'Jackpots offer incredible rewards, but winning requires strategy and consistency. Here\'s how to maximize your chances.' }],
          },
          {
            type: 'heading-two',
            children: [{ text: 'Eligibility Requirements' }],
          },
          {
            type: 'paragraph',
            children: [{ text: 'To be eligible for jackpots, you need to meet minimum streak and prediction requirements. Focus on building consistent winning streaks.' }],
          },
        ],
        thumbnail: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800',
        author: adminUser._id,
        category: 'Strategy',
        tags: ['Jackpot', 'Strategy'],
        isFeatured: false,
        isPublished: true,
        publishedAt: new Date('2024-05-15'),
        views: 720,
        likes: [users[3]._id, users[4]._id],
        comments: [],
      },
    ];

    for (const data of blogData) {
      const blog = new Blog(data);
      await blog.save();
    }

    console.log('Created blogs');

    // Update cup stats
    worldCup.activeMatches = createdMatches.filter(m => m.status === 'upcoming' || m.status === 'live').length;
    worldCup.activePolls = createdPolls.filter(p => p.status === 'active').length;
    await worldCup.save();

    console.log('\n✅ Seed data created successfully!');
    console.log('\n📊 Summary:');
    console.log('Users created:', users.length);
    console.log('  - Admin:', users.find(u => u.role === 'admin')?.username);
    console.log('  - SuperAdmin:', users.find(u => u.role === 'superAdmin')?.username);
    console.log('  - Regular users:', users.filter(u => u.role === 'user').length);
    console.log('\nCups created:', 5);
    console.log('Stages created:', 5);
    console.log('Matches created:', createdMatches.length);
    console.log('  - Upcoming:', createdMatches.filter(m => m.status === 'upcoming').length);
    console.log('  - Live:', createdMatches.filter(m => m.status === 'live').length);
    console.log('  - Completed:', createdMatches.filter(m => m.status === 'completed').length);
    console.log('  - Featured:', createdMatches.filter(m => m.isFeatured).length);
    console.log('\nPolls created:', createdPolls.length);
    console.log('Predictions created:', predictions.length);
    console.log('  - Free:', predictions.filter(p => p.type === 'free').length);
    console.log('  - Boost:', predictions.filter(p => p.type === 'boost').length);
    console.log('  - Market:', predictions.filter(p => p.type === 'market').length);
    console.log('\nBlogs created:', blogData.length);
    console.log('  - Featured:', blogData.filter(b => b.isFeatured).length);
    console.log('  - Published:', blogData.filter(b => b.isPublished).length);
    console.log('\n🔑 Test Accounts:');
    console.log('Admin: admin@wergame.com / admin123');
    console.log('SuperAdmin: superadmin@wergame.com / superadmin123');
    console.log('User: test@wergame.com / test123');
    console.log('Player1: player1@wergame.com / player1');
    console.log('Player2: player2@wergame.com / player2');
    console.log('\n💡 Features to test:');
    console.log('- Free predictions with daily tickets');
    console.log('- Boost predictions with ETH staking');
    console.log('- Market trading with liquidity pools');
    console.log('- Resolve matches and claim rewards');
    console.log('- View leaderboards and streaks');
    console.log('- Check jackpots eligibility');
    console.log('- Admin dashboard for match/poll management');

    process.exit(0);
  } catch (error) {
    console.error('Error seeding data:', error);
    process.exit(1);
  }
};

seedData();
