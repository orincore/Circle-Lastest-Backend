import { Router, Request } from 'express'
import { requireAuth, AuthRequest } from '../server/middleware/auth.js'
import { S3Service } from '../services/s3Service.js'
import { supabase } from '../server/config/supabase.js'
import multer from 'multer'

// Extend AuthRequest to include multer file
interface UploadRequest extends AuthRequest {
  file?: Express.Multer.File
}

const router = Router()

// Configure multer for memory storage (we'll upload directly to S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
})

/**
 * Upload profile photo
 * POST /api/upload/profile-photo
 */
router.post(
  '/profile-photo',
  requireAuth,
  upload.single('photo'),
  async (req: UploadRequest, res) => {
    try {
      const userId = req.user!.id

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' })
      }

      console.log('📸 Uploading profile photo:', {
        userId,
        fileName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      })

      // Upload to S3
      const result = await S3Service.uploadProfilePhoto(
        req.file.buffer,
        userId,
        req.file.mimetype
      )

      console.log('✅ Profile photo uploaded to S3:', result)

      // Update user profile in database
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          profile_photo_url: result.url,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)

      if (updateError) {
        console.error('❌ Failed to update profile:', updateError)
        // Try to delete the uploaded file
        try {
          await S3Service.deleteFile(result.key)
        } catch (deleteError) {
          console.error('Failed to cleanup S3 file:', deleteError)
        }
        return res.status(500).json({ error: 'Failed to update profile' })
      }

      console.log('✅ Profile updated with new photo URL')

      return res.json({
        success: true,
        url: result.url,
        key: result.key,
        message: 'Profile photo uploaded successfully',
      })
    } catch (error: any) {
      console.error('❌ Profile photo upload error:', error)
      return res.status(500).json({
        error: error.message || 'Failed to upload profile photo',
      })
    }
  }
)

/**
 * Upload media (image/video) - generic endpoint
 * POST /api/upload/media
 */
router.post(
  '/media',
  requireAuth,
  upload.single('file'),
  async (req: UploadRequest, res) => {
    try {
      const userId = req.user!.id

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' })
      }

      console.log('📎 Uploading media:', {
        userId,
        fileName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      })

      // Determine media type from request or mimetype
      const mediaType = req.body.type || (req.file.mimetype.startsWith('image/') ? 'image' : 'video')

      // Upload to S3 (use generic chat media upload)
      const result = await S3Service.uploadChatMedia(
        req.file.buffer,
        userId,
        'general', // Use 'general' as chatId for non-chat media
        req.file.mimetype
      )

      console.log('✅ Media uploaded to S3:', result)

      return res.json({
        success: true,
        url: result.url,
        type: mediaType,
        thumbnail: null, // Can add video thumbnail generation later
        message: 'Media uploaded successfully',
      })
    } catch (error: any) {
      console.error('❌ Media upload error:', error)
      return res.status(500).json({
        error: error.message || 'Failed to upload media',
      })
    }
  }
)

/**
 * Upload chat media (image/video)
 * POST /api/upload/chat-media
 */
router.post(
  '/chat-media',
  requireAuth,
  upload.single('media'),
  async (req: UploadRequest, res) => {
    try {
      const userId = req.user!.id
      const { chatId } = req.body

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' })
      }

      if (!chatId) {
        return res.status(400).json({ error: 'Chat ID is required' })
      }

      console.log('📎 Uploading chat media:', {
        userId,
        chatId,
        fileName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      })

      // Verify user is part of the chat
      const { data: chatMember } = await supabase
        .from('chat_participants')
        .select('id')
        .eq('chat_id', chatId)
        .eq('user_id', userId)
        .single()

      if (!chatMember) {
        return res.status(403).json({ error: 'Not authorized to upload to this chat' })
      }

      // Upload to S3
      const result = await S3Service.uploadChatMedia(
        req.file.buffer,
        userId,
        chatId,
        req.file.mimetype
      )

      console.log('✅ Chat media uploaded to S3:', result)

      return res.json({
        success: true,
        url: result.url,
        key: result.key,
        size: result.size,
        contentType: req.file.mimetype,
        message: 'Media uploaded successfully',
      })
    } catch (error: any) {
      console.error('❌ Chat media upload error:', error)
      return res.status(500).json({
        error: error.message || 'Failed to upload media',
      })
    }
  }
)

/**
 * Delete uploaded file
 * DELETE /api/upload/:key
 */
router.delete('/:key(*)', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const key = req.params.key

    if (!key) {
      return res.status(400).json({ error: 'File key is required' })
    }

    console.log('🗑️ Deleting file:', { userId, key })

    // Verify the file belongs to the user (check if key contains userId)
    if (!key.includes(userId)) {
      return res.status(403).json({ error: 'Not authorized to delete this file' })
    }

    await S3Service.deleteFile(key)

    console.log('✅ File deleted from S3')

    return res.json({
      success: true,
      message: 'File deleted successfully',
    })
  } catch (error: any) {
    console.error('❌ File deletion error:', error)
    return res.status(500).json({
      error: error.message || 'Failed to delete file',
    })
  }
})

/**
 * Get presigned URL for private file access
 * GET /api/upload/presigned-url?key=...
 */
router.get('/presigned-url', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { key } = req.query

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'File key is required' })
    }

    console.log('🔗 Generating presigned URL for:', key)

    const url = await S3Service.getPresignedUrl(key)

    return res.json({
      success: true,
      url,
      expiresIn: 3600, // 1 hour
    })
  } catch (error: any) {
    console.error('❌ Presigned URL generation error:', error)
    return res.status(500).json({
      error: error.message || 'Failed to generate presigned URL',
    })
  }
})

export default router
