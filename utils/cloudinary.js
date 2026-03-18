const cloudinary = require('cloudinary').v2;

// Configure Cloudinary with provided credentials
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dxufkhffc',
  api_key: process.env.CLOUDINARY_API_KEY || '226735658796427',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'YjGUXxKXTl4AJVKIauAyVAOBh7w'
});

/**
 * Upload image to Cloudinary
 * @param {Buffer|String} file - File buffer or base64 string
 * @param {Object} options - Upload options
 * @returns {Promise<Object>} Cloudinary upload result
 */
const uploadImage = async (file, options = {}) => {
  try {
    const uploadOptions = {
      folder: options.folder || 'wergame',
      resource_type: 'image',
      ...options
    };

    let result;
    
    // Handle multer file object (has buffer property)
    if (file && file.buffer && Buffer.isBuffer(file.buffer)) {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) {
              console.error('Cloudinary upload stream error:', error);
              reject(error);
            } else {
              resolve({
                url: result.secure_url,
                public_id: result.public_id,
                width: result.width,
                height: result.height,
                format: result.format
              });
            }
          }
        );
        uploadStream.end(file.buffer);
      });
    } 
    // Handle raw buffer
    else if (Buffer.isBuffer(file)) {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) {
              console.error('Cloudinary upload stream error:', error);
              reject(error);
            } else {
              resolve({
                url: result.secure_url,
                public_id: result.public_id,
                width: result.width,
                height: result.height,
                format: result.format
              });
            }
          }
        );
        uploadStream.end(file);
      });
    } 
    // Handle base64 string or URL
    else if (typeof file === 'string') {
      result = await cloudinary.uploader.upload(file, uploadOptions);
      return {
        url: result.secure_url,
        public_id: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format
      };
    } 
    else {
      throw new Error('Invalid file type. Expected multer file object, buffer, or base64 string.');
    }
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    throw new Error('Failed to upload image to Cloudinary: ' + error.message);
  }
};

/**
 * Delete image from Cloudinary
 * @param {String} publicId - Cloudinary public ID
 * @returns {Promise<Object>} Deletion result
 */
const deleteImage = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    throw new Error('Failed to delete image from Cloudinary');
  }
};

module.exports = {
  uploadImage,
  deleteImage,
  cloudinary
};
