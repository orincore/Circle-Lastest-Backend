# AWS S3 Integration Setup Guide

## Overview
This guide will help you set up AWS S3 for file uploads in the Circle app, including profile pictures, chat media, and other files.

## Prerequisites
- AWS Account
- AWS CLI installed (optional but recommended)
- Node.js and npm installed

## Step 1: Install Required Dependencies

```bash
cd Backend
npm install multer @types/multer
```

The AWS S3 SDK is already installed in the project.

## Step 2: Use Your Existing S3 Bucket

You already have a bucket named `media.orincore.com`. The Circle app will use a dedicated folder structure within this bucket:

```
media.orincore.com/
└── Circle/
    ├── avatars/{userId}/        # User profile pictures
    ├── chat-media/{userId}/     # Chat images and videos
    ├── posts/{userId}/          # User posts
    └── temp/{userId}/           # Temporary files
```

**No need to create a new bucket!** The app will automatically create the folder structure when files are uploaded.

For detailed folder structure documentation, see: `S3_FOLDER_STRUCTURE.md`

## Step 3: Configure CORS for S3 Bucket

Add CORS configuration to allow uploads from your frontend:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
    "AllowedOrigins": [
      "http://localhost:8081",
      "https://circle.orincore.com"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

**Using AWS Console:**
1. Go to [AWS S3 Console](https://s3.console.aws.amazon.com/)
2. Select your bucket: `media.orincore.com`
3. Go to Permissions → CORS
4. Paste the above JSON and save

**Using AWS CLI:**
```bash
aws s3api put-bucket-cors \
  --bucket media.orincore.com \
  --cors-configuration file://cors-config.json
```

## Step 4: Create IAM User for S3 Access

### Create IAM User
1. Go to [IAM Console](https://console.aws.amazon.com/iam/)
2. Click "Users" → "Add users"
3. **User name**: `circle-app-s3-user`
4. **Access type**: Programmatic access
5. Click "Next: Permissions"

### Attach Policy
Create a custom policy with these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetObjectAcl",
        "s3:PutObjectAcl"
      ],
      "Resource": [
        "arn:aws:s3:::media.orincore.com/Circle/*",
        "arn:aws:s3:::media.orincore.com"
      ],
      "Condition": {
        "StringLike": {
          "s3:prefix": ["Circle/*"]
        }
      }
    }
  ]
}
```

**Note**: This policy restricts access to only the `Circle/` folder within your bucket, keeping other content in `media.orincore.com` separate and secure.

**Steps:**
1. Click "Create policy" → JSON tab
2. Paste the above policy
3. Name it `CircleAppS3Policy`
4. Attach to the user
5. **Save the Access Key ID and Secret Access Key** (you'll need these)

## Step 5: Configure Environment Variables

Add these to your `.env` file:

```env
# AWS S3 Configuration
AWS_REGION=us-east-1
AWS_S3_BUCKET=media.orincore.com
AWS_ACCESS_KEY_ID=your_access_key_id_here
AWS_SECRET_ACCESS_KEY=your_secret_access_key_here
```

**Security Note:** Never commit these credentials to version control!

## Step 6: Test the Integration

### Test Profile Photo Upload
```bash
curl -X POST http://localhost:8080/api/upload/profile-photo \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "photo=@/path/to/image.jpg"
```

### Test Chat Media Upload
```bash
curl -X POST http://localhost:8080/api/upload/chat-media \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "media=@/path/to/image.jpg" \
  -F "chatId=your_chat_id"
```

## API Endpoints

### 1. Upload Profile Photo
**POST** `/api/upload/profile-photo`

**Headers:**
- `Authorization: Bearer <token>`
- `Content-Type: multipart/form-data`

**Body:**
- `photo`: File (max 5MB, images only)

**Response:**
```json
{
  "success": true,
  "url": "https://media.orincore.com/Circle/avatars/550e8400-e29b-41d4-a716-446655440000/avatar-1696234567890.jpg",
  "key": "Circle/avatars/550e8400-e29b-41d4-a716-446655440000/avatar-1696234567890.jpg",
  "message": "Profile photo uploaded successfully"
}
```

### 2. Upload Chat Media
**POST** `/api/upload/chat-media`

**Headers:**
- `Authorization: Bearer <token>`
- `Content-Type: multipart/form-data`

**Body:**
- `media`: File (max 10MB for images, 50MB for videos)
- `chatId`: String (required)

**Response:**
```json
{
  "success": true,
  "url": "https://media.orincore.com/Circle/chat-media/550e8400-e29b-41d4-a716-446655440000/image-1696234567891.jpg?X-Amz-Algorithm=...",
  "key": "Circle/chat-media/550e8400-e29b-41d4-a716-446655440000/image-1696234567891.jpg",
  "size": 1024000,
  "contentType": "image/jpeg",
  "message": "Media uploaded successfully"
}
```

### 3. Delete File
**DELETE** `/api/upload/:key`

**Headers:**
- `Authorization: Bearer <token>`

**Response:**
```json
{
  "success": true,
  "message": "File deleted successfully"
}
```

### 4. Get Presigned URL
**GET** `/api/upload/presigned-url?key=<file-key>`

**Headers:**
- `Authorization: Bearer <token>`

**Response:**
```json
{
  "success": true,
  "url": "https://presigned-url-here",
  "expiresIn": 3600
}
```

## File Size Limits

- **Profile Photos**: 5MB
- **Chat Images**: 10MB
- **Chat Videos**: 50MB
- **Post Images**: 10MB

## Allowed File Types

### Images
- `image/jpeg`
- `image/jpg`
- `image/png`
- `image/gif`
- `image/webp`

### Videos
- `video/mp4`
- `video/quicktime`
- `video/x-msvideo`

## S3 Folder Structure

```
media.orincore.com/
└── Circle/
    ├── avatars/
    │   └── {userId}/
    │       └── avatar-timestamp.jpg
    ├── chat-media/
    │   └── {userId}/
    │       ├── image-timestamp.jpg
    │       └── video-timestamp.mp4
    ├── posts/
    │   └── {userId}/
    │       └── post-timestamp.jpg
    └── temp/
        └── {userId}/
            └── temp-timestamp.jpg
```

**See `S3_FOLDER_STRUCTURE.md` for detailed documentation.**

## Security Best Practices

1. **Never expose AWS credentials** in frontend code
2. **Use presigned URLs** for private file access
3. **Implement file type validation** on both frontend and backend
4. **Set appropriate CORS policies** for your domains only
5. **Enable S3 bucket versioning** for file recovery
6. **Use S3 lifecycle policies** to automatically delete old temp files
7. **Enable CloudFront CDN** for better performance (optional)
8. **Monitor S3 costs** regularly

## Cost Optimization

### S3 Lifecycle Policy (Auto-delete temp files after 7 days)
```json
{
  "Rules": [
    {
      "Id": "DeleteTempFiles",
      "Status": "Enabled",
      "Prefix": "temp/",
      "Expiration": {
        "Days": 7
      }
    }
  ]
}
```

Apply using AWS CLI:
```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket media.orincore.com \
  --lifecycle-configuration file://lifecycle-policy.json
```

## Troubleshooting

### Error: "S3 is not configured"
- Check that all AWS environment variables are set in `.env`
- Restart your backend server after adding env variables

### Error: "Access Denied"
- Verify IAM user has correct permissions
- Check bucket policy and CORS configuration
- Ensure AWS credentials are correct

### Error: "File size exceeds maximum"
- Check file size limits in `S3_CONFIG`
- Adjust limits if needed for your use case

### Error: "Invalid file type"
- Verify file MIME type is in allowed types list
- Check `S3_CONFIG.ALLOWED_TYPES` configuration

## Production Checklist

- [ ] S3 bucket created with appropriate region
- [ ] CORS configured for production domain
- [ ] IAM user created with minimal required permissions
- [ ] Environment variables set in production
- [ ] Bucket versioning enabled
- [ ] Server-side encryption enabled
- [ ] Lifecycle policies configured
- [ ] CloudWatch alarms set up for monitoring
- [ ] Cost alerts configured
- [ ] Backup strategy in place

## Next Steps

1. Install multer: `npm install multer @types/multer`
2. Set up AWS S3 bucket and IAM user
3. Configure environment variables
4. Test uploads with curl or Postman
5. Integrate frontend upload components
6. Monitor S3 usage and costs

## Support

For issues or questions:
- Check AWS S3 documentation: https://docs.aws.amazon.com/s3/
- Review backend logs for detailed error messages
- Verify IAM permissions and bucket policies
