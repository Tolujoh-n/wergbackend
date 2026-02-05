const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const blogSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
  },
  description: {
    type: String,
    required: true,
  },
  content: {
    type: mongoose.Schema.Types.Mixed, // For Slate editor content
    required: true,
  },
  thumbnail: {
    type: String,
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  category: {
    type: String,
    default: 'General',
  },
  tags: [{
    type: String,
  }],
  isFeatured: {
    type: Boolean,
    default: false,
  },
  isPublished: {
    type: Boolean,
    default: false,
  },
  views: {
    type: Number,
    default: 0,
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  comments: [commentSchema],
  publishedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

blogSchema.pre('save', async function(next) {
  // Auto-generate slug if slug doesn't exist and title exists
  if ((!this.slug || this.slug === '') && this.title) {
    const baseSlug = this.title.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    
    // Check if slug exists, if so add number suffix
    let slug = baseSlug;
    let counter = 1;
    const Blog = this.constructor;
    
    while (true) {
      const existingBlog = await Blog.findOne({ slug: slug, _id: { $ne: this._id } });
      if (!existingBlog) {
        break;
      }
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    this.slug = slug;
  }
  // Always update updatedAt
  this.updatedAt = new Date();
  // Call next to continue
  if (next && typeof next === 'function') {
    next();
  }
});

module.exports = mongoose.model('Blog', blogSchema);
