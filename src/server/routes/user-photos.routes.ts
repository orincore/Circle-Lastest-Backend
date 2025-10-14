import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import multer from 'multer';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { supabase } from '../config/supabase.js';

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
const MAX_PHOTOS = 5;

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    // Accept only images
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

/**
 * GET /api/users/photos
 * Get user's photo gallery
 */
router.get('/photos', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    // Fetch photos from database
    const { data: photos, error } = await supabase
      .from('user_photos')
      .select('id, photo_url, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching photos:', error);
      return res.status(500).json({ error: 'Failed to fetch photos' });
    }

    // Format response
    const formattedPhotos = (photos || []).map(photo => ({
      id: photo.id,
      url: photo.photo_url,
      createdAt: photo.created_at,
    }));

    res.json({ photos: formattedPhotos });
  } catch (error) {
    console.error('Get photos error:', error);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

/**
 * POST /api/users/photos
 * Upload a photo to user's gallery
 */
router.post('/photos', requireAuth, upload.single('photo'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = req.user!.id;

    // Check current photo count
    const { count, error: countError } = await supabase
      .from('user_photos')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (countError) {
      console.error('Error counting photos:', countError);
      return res.status(500).json({ error: 'Failed to check photo count' });
    }

    if (count && count >= MAX_PHOTOS) {
      return res.status(400).json({ 
        error: `Maximum ${MAX_PHOTOS} photos allowed`,
        message: `You can only upload up to ${MAX_PHOTOS} photos` 
      });
    }

    // Generate unique filename
    const fileExtension = path.extname(req.file.originalname) || '.jpg';
    const fileName = `photo-${uuidv4()}${fileExtension}`;
    const key = `Circle/gallery/${userId}/${fileName}`;

    let buffer = req.file.buffer;
    let contentType = 'image/jpeg';

    // Compress and resize photo
    try {
      buffer = await sharp(req.file.buffer)
        .resize(1920, 1920, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
      
      //console.log(`✅ Photo compressed: ${buffer.length / 1024} KB`);
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
    };

    await s3Client.send(new PutObjectCommand(uploadParams));

    // Generate URL
    const photoUrl = `https://${BUCKET_NAME}/${key}`;

    // Save to database
    const { data: photo, error: dbError } = await supabase
      .from('user_photos')
      .insert({
        user_id: userId,
        photo_url: photoUrl,
      })
      .select()
      .single();

    if (dbError) {
      console.error('Error saving photo to database:', dbError);
      // Try to delete from S3 if database save fails
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
        }));
      } catch (deleteError) {
        console.error('Failed to cleanup S3 after database error:', deleteError);
      }
      return res.status(500).json({ error: 'Failed to save photo' });
    }

    //console.log(`✅ Photo uploaded successfully: ${photoUrl}`);

    res.json({
      success: true,
      photoUrl,
      photo: {
        id: photo.id,
        url: photo.photo_url,
        createdAt: photo.created_at,
      },
    });
  } catch (error) {
    console.error('Photo upload error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

/**
 * DELETE /api/users/photos
 * Delete a photo from user's gallery
 */
router.delete('/photos', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { photoUrl } = req.body;

    if (!photoUrl) {
      return res.status(400).json({ error: 'Photo URL is required' });
    }

    // Verify ownership and get photo record
    const { data: photo, error: fetchError } = await supabase
      .from('user_photos')
      .select('*')
      .eq('user_id', userId)
      .eq('photo_url', photoUrl)
      .single();

    if (fetchError || !photo) {
      console.error('Photo not found or unauthorized:', fetchError);
      return res.status(404).json({ error: 'Photo not found or unauthorized' });
    }

    // Extract S3 key from URL
    const urlParts = photoUrl.split(`${BUCKET_NAME}/`);
    if (urlParts.length < 2) {
      return res.status(400).json({ error: 'Invalid photo URL' });
    }
    const key = urlParts[1];

    // Delete from S3
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }));
      //console.log(`✅ Photo deleted from S3: ${key}`);
    } catch (s3Error) {
      console.error('Error deleting from S3:', s3Error);
      // Continue with database deletion even if S3 fails
    }

    // Delete from database
    const { error: deleteError } = await supabase
      .from('user_photos')
      .delete()
      .eq('id', photo.id);

    if (deleteError) {
      console.error('Error deleting photo from database:', deleteError);
      return res.status(500).json({ error: 'Failed to delete photo' });
    }

    //console.log(`✅ Photo deleted successfully: ${photoUrl}`);

    res.json({
      success: true,
      message: 'Photo deleted successfully',
    });
  } catch (error) {
    console.error('Photo deletion error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

/**
 * GET /api/users/:userId/photos
 * Get another user's photo gallery (public view)
 */
router.get('/:userId/photos', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;

    // Fetch photos from database
    const { data: photos, error } = await supabase
      .from('user_photos')
      .select('id, photo_url, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching photos:', error);
      return res.status(500).json({ error: 'Failed to fetch photos' });
    }

    // Format response
    const formattedPhotos = (photos || []).map(photo => ({
      id: photo.id,
      url: photo.photo_url,
      createdAt: photo.created_at,
    }));

    res.json({ photos: formattedPhotos });
  } catch (error) {
    console.error('Get user photos error:', error);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

export default router;
