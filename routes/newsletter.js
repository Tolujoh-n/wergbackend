const express = require('express');
const cors = require('cors');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');

const router = express.Router();

/** Allow subscriptions from any origin (footer, partner sites, etc.). */
const publicCors = cors({ origin: true });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

router.options('/subscribe', publicCors);
router.post('/subscribe', publicCors, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    const source =
      String(req.body?.source || 'website')
        .trim()
        .slice(0, 120) || 'website';

    const existing = await NewsletterSubscriber.findOne({ email }).lean();
    if (existing) {
      return res.status(200).json({
        message: 'You are already subscribed to our newsletter.',
        alreadySubscribed: true,
      });
    }

    await NewsletterSubscriber.create({
      email,
      source,
      ip: req.ip || req.headers['x-forwarded-for'] || '',
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    });

    res.status(201).json({
      message: 'Thanks for subscribing! We will keep you updated.',
      alreadySubscribed: false,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(200).json({
        message: 'You are already subscribed to our newsletter.',
        alreadySubscribed: true,
      });
    }
    console.error('newsletter subscribe', error);
    res.status(500).json({ message: error.message || 'Subscription failed. Please try again.' });
  }
});

module.exports = router;
