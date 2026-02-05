const express = require('express');
const Blog = require('../models/Blog');
const { auth, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all published blogs
router.get('/', async (req, res) => {
  try {
    const { category, tag, search, featured } = req.query;
    const query = { isPublished: true };

    if (featured === 'true') {
      query.isFeatured = true;
    }
    if (category) {
      query.category = category;
    }
    if (tag) {
      query.tags = tag;
    }
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const blogs = await Blog.find(query)
      .populate('author', 'username')
      .sort({ publishedAt: -1, createdAt: -1 })
      .select('-content'); // Don't send full content in list

    res.json(blogs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get featured blogs (max 3)
router.get('/featured', async (req, res) => {
  try {
    const blogs = await Blog.find({ isPublished: true, isFeatured: true })
      .populate('author', 'username')
      .sort({ publishedAt: -1 })
      .limit(3)
      .select('-content');

    res.json(blogs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get blog by slug
router.get('/:slug', async (req, res) => {
  try {
    const blog = await Blog.findOne({ slug: req.params.slug, isPublished: true })
      .populate('author', 'username email')
      .populate('likes', 'username')
      .populate('comments.user', 'username');

    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    // Increment views
    blog.views += 1;
    await blog.save();

    res.json(blog);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Like/Unlike blog
router.post('/:slug/like', auth, async (req, res) => {
  try {
    const blog = await Blog.findOne({ slug: req.params.slug });
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    const userId = req.user._id;
    const likeIndex = blog.likes.findIndex(id => id.toString() === userId.toString());

    if (likeIndex > -1) {
      blog.likes.splice(likeIndex, 1);
    } else {
      blog.likes.push(userId);
    }

    await blog.save();
    res.json({ likes: blog.likes.length, isLiked: likeIndex === -1 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add comment
router.post('/:slug/comment', auth, async (req, res) => {
  try {
    const { content } = req.body;
    const blog = await Blog.findOne({ slug: req.params.slug });
    
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    blog.comments.push({
      user: req.user._id,
      content,
    });

    await blog.save();
    const comment = blog.comments[blog.comments.length - 1];
    await comment.populate('user', 'username');

    res.status(201).json(comment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get categories
router.get('/meta/categories', async (req, res) => {
  try {
    const categories = await Blog.distinct('category', { isPublished: true });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get tags
router.get('/meta/tags', async (req, res) => {
  try {
    const blogs = await Blog.find({ isPublished: true }).select('tags');
    const allTags = blogs.reduce((acc, blog) => {
      if (blog.tags) {
        acc.push(...blog.tags);
      }
      return acc;
    }, []);
    const uniqueTags = [...new Set(allTags)];
    res.json(uniqueTags);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
