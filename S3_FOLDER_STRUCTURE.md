# S3 Folder Structure for Circle App

## Bucket: media.orincore.com

### Complete Folder Hierarchy

```
media.orincore.com/
└── Circle/                                    # Base folder for Circle app
    ├── avatars/                               # User profile pictures (PUBLIC)
    │   ├── {userId-1}/                        # Individual user folder
    │   │   ├── avatar-1234567890.jpg          # Profile photo with timestamp
    │   │   ├── avatar-1234567891.png          # Updated profile photo
    │   │   └── avatar-1234567892.webp         # Latest profile photo
    │   ├── {userId-2}/
    │   │   └── avatar-1234567893.jpg
    │   └── {userId-3}/
    │       └── avatar-1234567894.png
    │
    ├── chat-media/                            # Chat images and videos (PRIVATE)
    │   ├── {userId-1}/                        # Individual user folder
    │   │   ├── image-1234567890.jpg           # Chat image with timestamp
    │   │   ├── video-1234567891.mp4           # Chat video with timestamp
    │   │   └── image-1234567892.png           # Another chat image
    │   ├── {userId-2}/
    │   │   ├── image-1234567893.jpg
    │   │   └── video-1234567894.mp4
    │   └── {userId-3}/
    │       └── image-1234567895.png
    │
    ├── posts/                                 # User posts (PUBLIC)
    │   ├── {userId-1}/                        # Individual user folder
    │   │   ├── post-1234567890.jpg            # Post image with timestamp
    │   │   └── post-1234567891.png            # Another post image
    │   └── {userId-2}/
    │       └── post-1234567892.jpg
    │
    └── temp/                                  # Temporary files (AUTO-DELETE after 7 days)
        ├── {userId-1}/                        # Individual user folder
        │   └── temp-1234567890.jpg            # Temporary file
        └── {userId-2}/
            └── temp-1234567891.png            # Temporary file
```

## Folder Details

### 1. Circle/avatars/{userId}/
**Purpose**: Store user profile pictures (avatars)

**Access**: Public (direct URLs)

**File Naming**: `avatar-{timestamp}.{ext}`

**Example URL**: 
```
https://media.orincore.com/Circle/avatars/550e8400-e29b-41d4-a716-446655440000/avatar-1696234567890.jpg
```

**Features**:
- Each user has their own folder identified by UUID
- Multiple versions can exist (user can update profile photo)
- Public access for easy display across the app
- Automatic cleanup of old avatars can be implemented

---

### 2. Circle/chat-media/{userId}/
**Purpose**: Store chat images and videos sent by users

**Access**: Private (presigned URLs required)

**File Naming**: 
- Images: `image-{timestamp}.{ext}`
- Videos: `video-{timestamp}.{ext}`

**Example URL**: 
```
https://media.orincore.com/Circle/chat-media/550e8400-e29b-41d4-a716-446655440000/image-1696234567890.jpg?X-Amz-Algorithm=...
```

**Features**:
- Each user has their own folder for all their chat media
- Private access ensures only authorized users can view
- Supports both images and videos
- Metadata includes chatId for tracking

---

### 3. Circle/posts/{userId}/
**Purpose**: Store user post images (future feature)

**Access**: Public (direct URLs)

**File Naming**: `post-{timestamp}.{ext}`

**Example URL**: 
```
https://media.orincore.com/Circle/posts/550e8400-e29b-41d4-a716-446655440000/post-1696234567890.jpg
```

**Features**:
- Each user has their own folder for post images
- Public access for social feed display
- Can be extended for multiple images per post

---

### 4. Circle/temp/{userId}/
**Purpose**: Store temporary files during processing

**Access**: Private (presigned URLs)

**File Naming**: `temp-{timestamp}.{ext}`

**Lifecycle**: Auto-delete after 7 days

**Features**:
- Temporary storage for file processing
- Automatic cleanup to save costs
- User-specific folders for organization

---

## File URL Formats

### Public Files (Avatars, Posts)
```
https://media.orincore.com/Circle/avatars/{userId}/avatar-{timestamp}.jpg
```
- Direct access without authentication
- Can be cached by CDN
- Fast loading times

### Private Files (Chat Media, Temp)
```
https://media.orincore.com/Circle/chat-media/{userId}/image-{timestamp}.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Expires=3600
```
- Requires presigned URL
- Expires after 1 hour (configurable)
- Secure access control

---

## Benefits of This Structure

### 1. **User Isolation**
- Each user has their own folder (UUID-based)
- Easy to find and manage user's files
- Clear ownership and permissions

### 2. **Scalability**
- Flat structure within user folders
- No deep nesting issues
- Easy to add new file types

### 3. **Security**
- Public vs private access clearly defined
- User-specific folders prevent unauthorized access
- Presigned URLs for sensitive content

### 4. **Organization**
- Files grouped by type (avatars, chat-media, posts)
- Easy to implement different retention policies
- Simple to backup or migrate

### 5. **Performance**
- Direct URLs for public content
- CDN-friendly structure
- Efficient file retrieval

---

## File Metadata

Each uploaded file includes metadata:

```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "uploadedAt": "2024-10-01T12:30:45.123Z",
  "type": "avatar",
  "chatId": "optional-chat-id-for-chat-media"
}
```

---

## Example Upload Paths

### Profile Photo Upload
```
User ID: 550e8400-e29b-41d4-a716-446655440000
File: profile.jpg
Upload Time: 1696234567890

Result Path: Circle/avatars/550e8400-e29b-41d4-a716-446655440000/avatar-1696234567890.jpg
```

### Chat Image Upload
```
User ID: 550e8400-e29b-41d4-a716-446655440000
Chat ID: chat-abc123
File: photo.png
Upload Time: 1696234567891

Result Path: Circle/chat-media/550e8400-e29b-41d4-a716-446655440000/image-1696234567891.png
```

### Chat Video Upload
```
User ID: 550e8400-e29b-41d4-a716-446655440000
Chat ID: chat-abc123
File: video.mp4
Upload Time: 1696234567892

Result Path: Circle/chat-media/550e8400-e29b-41d4-a716-446655440000/video-1696234567892.mp4
```

---

## Lifecycle Policies

### Recommended S3 Lifecycle Rules

#### 1. Temp Files Auto-Deletion
```json
{
  "Rules": [
    {
      "Id": "DeleteTempFiles",
      "Status": "Enabled",
      "Prefix": "Circle/temp/",
      "Expiration": {
        "Days": 7
      }
    }
  ]
}
```

#### 2. Old Avatar Versions (Optional)
```json
{
  "Rules": [
    {
      "Id": "ArchiveOldAvatars",
      "Status": "Enabled",
      "Prefix": "Circle/avatars/",
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 30
      }
    }
  ]
}
```

---

## CORS Configuration

Add this CORS configuration to your `media.orincore.com` bucket:

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

---

## IAM Policy for Circle App

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
        "s3:ListBucket"
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

This policy restricts access to only the `Circle/` folder in your bucket.

---

## Migration from Old Structure

If you have existing files in a different structure, use this script:

```bash
#!/bin/bash
# Migrate existing profile photos to new structure

aws s3 ls s3://media.orincore.com/profile-photos/ | while read -r line; do
  fileName=$(echo $line | awk '{print $4}')
  userId=$(echo $fileName | cut -d'-' -f1)
  
  aws s3 mv \
    s3://media.orincore.com/profile-photos/$fileName \
    s3://media.orincore.com/Circle/avatars/$userId/$fileName
done
```

---

## Monitoring and Costs

### Storage Estimates (1000 users)
- **Avatars**: ~2MB per user = 2GB total
- **Chat Media**: ~50MB per active user = 50GB total
- **Posts**: ~20MB per user = 20GB total
- **Total**: ~72GB

### Monthly Cost Estimate
- **Storage (72GB)**: ~$1.66/month
- **PUT Requests (10K)**: ~$0.05/month
- **GET Requests (1M)**: ~$0.40/month
- **Data Transfer (50GB)**: ~$4.50/month

**Total: ~$6.61/month**

---

## Summary

✅ **Organized**: Clear folder structure by file type and user
✅ **Scalable**: Flat structure within user folders
✅ **Secure**: Public/private access properly configured
✅ **Cost-Effective**: Lifecycle policies for automatic cleanup
✅ **User-Friendly**: UUID-based folders for easy management
✅ **Future-Proof**: Easy to extend with new file types

Your S3 bucket `media.orincore.com` is now perfectly organized for the Circle app!
