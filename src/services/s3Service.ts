import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, S3_CONFIG, isS3Configured } from '../config/s3.js'
import crypto from 'crypto'
import path from 'path'

export interface UploadOptions {
  folder?: string
  fileName?: string
  contentType?: string
  metadata?: Record<string, string>
  isPublic?: boolean
}

export interface UploadResult {
  key: string
  url: string
  bucket: string
  size?: number
}

/**
 * S3 Service for file uploads and management
 */
export class S3Service {
  /**
   * Upload a file buffer to S3
   */
  static async uploadFile(
    buffer: Buffer,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured. Please set AWS environment variables.')
    }

    const {
      folder = S3_CONFIG.FOLDERS.TEMP,
      fileName,
      contentType = 'application/octet-stream',
      metadata = {},
      isPublic = false,
    } = options

    // Generate unique file name if not provided
    const uniqueFileName = fileName || this.generateUniqueFileName(contentType)
    const key = `${folder}/${uniqueFileName}`

    const command = new PutObjectCommand({
      Bucket: S3_CONFIG.BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      Metadata: metadata,
      // ACL removed - bucket has ACLs disabled, using bucket policy instead
    })

    await s3Client.send(command)

    // Use custom domain for public URLs (media.orincore.com)
    // For private files, use presigned URLs
    const url = isPublic
      ? `https://${S3_CONFIG.BUCKET_NAME}/${key}`
      : await this.getPresignedUrl(key)

    return {
      key,
      url,
      bucket: S3_CONFIG.BUCKET_NAME,
      size: buffer.length,
    }
  }

  /**
   * Upload profile photo
   * Uploads to: Circle/avatars/{userId}/filename.ext
   */
  static async uploadProfilePhoto(
    buffer: Buffer,
    userId: string,
    contentType: string
  ): Promise<UploadResult> {
    // Validate file size
    if (buffer.length > S3_CONFIG.MAX_FILE_SIZE.PROFILE_PHOTO) {
      throw new Error(
        `File size exceeds maximum allowed size of ${S3_CONFIG.MAX_FILE_SIZE.PROFILE_PHOTO / 1024 / 1024}MB`
      )
    }

    // Validate content type
    if (!S3_CONFIG.ALLOWED_TYPES.IMAGES.includes(contentType)) {
      throw new Error(
        `Invalid file type. Allowed types: ${S3_CONFIG.ALLOWED_TYPES.IMAGES.join(', ')}`
      )
    }

    const extension = this.getExtensionFromMimeType(contentType)
    const timestamp = Date.now()
    const fileName = `avatar-${timestamp}.${extension}`
    
    // Folder structure: Circle/avatars/{userId}/
    const folder = `${S3_CONFIG.BASE_FOLDER}/${S3_CONFIG.FOLDERS.AVATARS}/${userId}`

    return this.uploadFile(buffer, {
      folder,
      fileName,
      contentType,
      metadata: {
        userId,
        uploadedAt: new Date().toISOString(),
        type: 'avatar',
      },
      isPublic: true, // Profile photos are public
    })
  }

  /**
   * Upload chat media (images/videos)
   * Uploads to: Circle/chat-media/{userId}/filename.ext
   */
  static async uploadChatMedia(
    buffer: Buffer,
    userId: string,
    chatId: string,
    contentType: string
  ): Promise<UploadResult> {
    const isImage = S3_CONFIG.ALLOWED_TYPES.IMAGES.includes(contentType)
    const isVideo = S3_CONFIG.ALLOWED_TYPES.VIDEOS.includes(contentType)

    if (!isImage && !isVideo) {
      throw new Error('Invalid file type for chat media')
    }

    const maxSize = isImage
      ? S3_CONFIG.MAX_FILE_SIZE.CHAT_IMAGE
      : S3_CONFIG.MAX_FILE_SIZE.CHAT_VIDEO

    if (buffer.length > maxSize) {
      throw new Error(
        `File size exceeds maximum allowed size of ${maxSize / 1024 / 1024}MB`
      )
    }

    const extension = this.getExtensionFromMimeType(contentType)
    const timestamp = Date.now()
    const mediaType = isImage ? 'image' : 'video'
    const fileName = `${mediaType}-${timestamp}.${extension}`
    
    // Folder structure: Circle/chat-media/{userId}/
    const folder = `${S3_CONFIG.BASE_FOLDER}/${S3_CONFIG.FOLDERS.CHAT_MEDIA}/${userId}`

    return this.uploadFile(buffer, {
      folder,
      fileName,
      contentType,
      metadata: {
        userId,
        chatId,
        uploadedAt: new Date().toISOString(),
        type: mediaType,
      },
      isPublic: false, // Chat media is private
    })
  }

  /**
   * Delete a file from S3
   */
  static async deleteFile(key: string): Promise<void> {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured')
    }

    const command = new DeleteObjectCommand({
      Bucket: S3_CONFIG.BUCKET_NAME,
      Key: key,
    })

    await s3Client.send(command)
  }

  /**
   * Get a presigned URL for private file access
   */
  static async getPresignedUrl(
    key: string,
    expiresIn: number = S3_CONFIG.PRESIGNED_URL_EXPIRATION
  ): Promise<string> {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured')
    }

    const command = new GetObjectCommand({
      Bucket: S3_CONFIG.BUCKET_NAME,
      Key: key,
    })

    return getSignedUrl(s3Client, command, { expiresIn })
  }

  /**
   * Check if a file exists in S3
   */
  static async fileExists(key: string): Promise<boolean> {
    if (!isS3Configured()) {
      return false
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: S3_CONFIG.BUCKET_NAME,
        Key: key,
      })
      await s3Client.send(command)
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Generate a unique file name
   */
  private static generateUniqueFileName(contentType: string): string {
    const extension = this.getExtensionFromMimeType(contentType)
    const randomString = crypto.randomBytes(16).toString('hex')
    const timestamp = Date.now()
    return `${timestamp}-${randomString}.${extension}`
  }

  /**
   * Get file extension from MIME type
   */
  private static getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'application/pdf': 'pdf',
    }

    return mimeToExt[mimeType] || 'bin'
  }

  /**
   * Extract S3 key from URL
   */
  static extractKeyFromUrl(url: string): string | null {
    try {
      // Handle S3 URLs in different formats
      const patterns = [
        // Custom domain: https://media.orincore.com/key
        new RegExp(`https://${S3_CONFIG.BUCKET_NAME}/(.+)`),
        // https://bucket.s3.region.amazonaws.com/key
        /https:\/\/[^.]+\.s3\.[^.]+\.amazonaws\.com\/(.+)/,
        // https://s3.region.amazonaws.com/bucket/key
        /https:\/\/s3\.[^.]+\.amazonaws\.com\/[^/]+\/(.+)/,
        // Presigned URLs
        /https:\/\/[^.]+\.s3\.[^.]+\.amazonaws\.com\/([^?]+)/,
      ]

      for (const pattern of patterns) {
        const match = url.match(pattern)
        if (match) {
          return decodeURIComponent(match[1])
        }
      }

      return null
    } catch (error) {
      console.error('Error extracting S3 key from URL:', error)
      return null
    }
  }

  /**
   * Get file size from S3
   */
  static async getFileSize(key: string): Promise<number | null> {
    if (!isS3Configured()) {
      return null
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: S3_CONFIG.BUCKET_NAME,
        Key: key,
      })
      const response = await s3Client.send(command)
      return response.ContentLength || null
    } catch (error) {
      console.error('Error getting file size:', error)
      return null
    }
  }
}
