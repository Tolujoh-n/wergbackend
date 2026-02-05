const mongoose = require('mongoose');
const Blog = require('../models/Blog');
require('dotenv').config();

const normalizeContent = (content) => {
  if (!content) {
    return [{ type: 'paragraph', children: [{ text: '' }] }];
  }
  
  // If it's already a valid array, return it
  if (Array.isArray(content) && content.length > 0) {
    // Validate structure
    const isValid = content.every(node => 
      node && 
      typeof node === 'object' && 
      node.type && 
      typeof node.type === 'string' &&
      Array.isArray(node.children) &&
      node.children.length > 0
    );
    if (isValid) {
      return content;
    }
  }
  
  // If it's a string, try to parse it
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const isValid = parsed.every(node => 
          node && 
          typeof node === 'object' && 
          node.type && 
          typeof node.type === 'string' &&
          Array.isArray(node.children) &&
          node.children.length > 0
        );
        if (isValid) {
          return parsed;
        }
      }
      // If parsing fails or result is invalid, convert string to paragraph
      return [{ type: 'paragraph', children: [{ text: content }] }];
    } catch (e) {
      // If JSON parse fails, treat as plain text
      return [{ type: 'paragraph', children: [{ text: content }] }];
    }
  }
  
  // Default fallback
  return [{ type: 'paragraph', children: [{ text: '' }] }];
};

async function fixBlogContent() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/wergame';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Find all blogs
    const blogs = await Blog.find({});
    console.log(`Found ${blogs.length} blogs to check`);

    let fixedCount = 0;
    let skippedCount = 0;

    for (const blog of blogs) {
      const normalizedContent = normalizeContent(blog.content);
      
      // Check if content needs to be fixed
      const needsFix = JSON.stringify(blog.content) !== JSON.stringify(normalizedContent);
      
      if (needsFix) {
        blog.content = normalizedContent;
        await blog.save();
        console.log(`Fixed blog: ${blog.title} (${blog._id})`);
        fixedCount++;
      } else {
        skippedCount++;
      }
    }

    console.log(`\nMigration complete!`);
    console.log(`Fixed: ${fixedCount} blogs`);
    console.log(`Skipped: ${skippedCount} blogs (already valid)`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('Error fixing blog content:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the migration
fixBlogContent();
