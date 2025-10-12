import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const router = Router();

// Configure S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || 'media.orincore.com';

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (req, file, cb) => {
    // Accept images and videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  },
});

/**
 * Upload profile photo to S3
 */
router.post('/profile-photo', requireAuth, upload.single('photo'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = req.user!.id;
    const fileExtension = path.extname(req.file.originalname) || '.jpg';
    const fileName = `avatar-${Date.now()}${fileExtension}`;
    const key = `Circle/avatars/${userId}/${fileName}`;

    let buffer = req.file.buffer;
    let contentType = req.file.mimetype;

    // Compress and resize profile photo
    try {
      buffer = await sharp(req.file.buffer)
        .resize(800, 800, {
          fit: 'cover',
          position: 'center',
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      
      contentType = 'image/jpeg';
      console.log(`✅ Profile photo compressed: ${buffer.length / 1024} KB`);
    } catch (error) {
      console.error('Image compression failed:', error);
      // Continue with original buffer if compression fails
    }

    // Upload to S3
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // ACL removed - bucket uses bucket policy for public access instead
    };

    await s3Client.send(new PutObjectCommand(uploadParams));

    // Generate URL (bucket should have public read policy configured)
    const url = `https://${BUCKET_NAME}/${key}`;

    console.log(`✅ Profile photo uploaded successfully: ${url}`);

    res.json({
      success: true,
      url,
    });
  } catch (error) {
    console.error('Profile photo upload error:', error);
    res.status(500).json({ error: 'Failed to upload profile photo' });
  }
});

/**
 * Upload media to S3
 */
router.post('/media', requireAuth, upload.single('file'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = req.user!.id;
    const mediaType = req.body.type || 'image'; // 'image' or 'video'
    const fileExtension = path.extname(req.file.originalname);
    const fileName = `${uuidv4()}${fileExtension}`;
    const key = `chat-media/${userId}/${fileName}`;

    let buffer = req.file.buffer;
    let contentType = req.file.mimetype;

    // Compress image if it's an image
    if (mediaType === 'image' && req.file.mimetype.startsWith('image/')) {
      try {
        buffer = await sharp(req.file.buffer)
          .resize(1920, 1920, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 80 })
          .toBuffer();
        
        contentType = 'image/jpeg';
        console.log(`✅ Image compressed: ${buffer.length / 1024} KB`);
      } catch (error) {
        console.error('Image compression failed:', error);
        // Continue with original buffer if compression fails
      }
    }

    // Upload to S3
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // ACL removed - bucket uses bucket policy for public access instead
    };

    await s3Client.send(new PutObjectCommand(uploadParams));

    // Generate URL (bucket should have public read policy configured)
    const url = `https://${BUCKET_NAME}/${key}`;

    // For videos, generate thumbnail (optional - can be done async)
    let thumbnail = null;
    if (mediaType === 'video') {
      // TODO: Implement video thumbnail generation
      // For now, return null
      thumbnail = null;
    }

    console.log(`✅ Media uploaded successfully: ${url}`);

    res.json({
      success: true,
      url,
      thumbnail,
      type: mediaType,
    });
  } catch (error) {
    console.error('Media upload error:', error);
    res.status(500).json({ error: 'Failed to upload media' });
  }
});

export default router;
