import { S3Client } from '@aws-sdk/client-s3'
import { env } from '../server/config/env'

/**
 * AWS S3 Client Configuration
 * Used for uploading profile pictures, media, and other files
 */
export const s3Client = new S3Client({
  region: env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || '',
  },
})

/**
 * S3 Configuration Constants
 */
export const S3_CONFIG = {
  BUCKET_NAME: env.AWS_S3_BUCKET || 'media.orincore.com',
  REGION: env.AWS_REGION || 'us-east-1',
  
  // Base folder for Circle app
  BASE_FOLDER: 'Circle',
  
  // Folder structure in S3: Circle/avatars/{userId}/*, Circle/chat-media/{userId}/*, etc.
  FOLDERS: {
    AVATARS: 'avatars',        // Circle/avatars/{userId}/
    CHAT_MEDIA: 'chat-media',  // Circle/chat-media/{userId}/
    POSTS: 'posts',            // Circle/posts/{userId}/
    TEMP: 'temp',              // Circle/temp/{userId}/
  },
  
  // File size limits (in bytes)
  MAX_FILE_SIZE: {
    PROFILE_PHOTO: 5 * 1024 * 1024, // 5MB
    CHAT_IMAGE: 10 * 1024 * 1024, // 10MB
    CHAT_VIDEO: 50 * 1024 * 1024, // 50MB
    POST_IMAGE: 10 * 1024 * 1024, // 10MB
  },
  
  // Allowed MIME types
  ALLOWED_TYPES: {
    IMAGES: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
    VIDEOS: ['video/mp4', 'video/quicktime', 'video/x-msvideo'],
    DOCUMENTS: ['application/pdf'],
  },
  
  // Presigned URL expiration (in seconds)
  PRESIGNED_URL_EXPIRATION: 3600, // 1 hour
}

/**
 * Check if S3 is properly configured
 */
export function isS3Configured(): boolean {
  return !!(
    env.AWS_REGION &&
    env.AWS_S3_BUCKET &&
    env.AWS_ACCESS_KEY_ID &&
    env.AWS_SECRET_ACCESS_KEY
  )
}
