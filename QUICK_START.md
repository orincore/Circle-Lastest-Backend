# 🚀 Quick Start - S3 Integration

## Your Bucket: `media.orincore.com`

The Circle app will use this folder structure:

```
media.orincore.com/
└── Circle/
    ├── avatars/{userId}/avatar-timestamp.jpg
    ├── chat-media/{userId}/image-timestamp.jpg
    ├── posts/{userId}/post-timestamp.jpg
    └── temp/{userId}/temp-timestamp.jpg
```

---

## ⚡ 3-Step Setup

### Step 1: Install Dependencies (30 seconds)
```bash
cd Backend
npm install multer @types/multer
```

### Step 2: Add to `.env` (1 minute)
```env
AWS_REGION=us-east-1
AWS_S3_BUCKET=media.orincore.com
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
```

### Step 3: Configure CORS on S3 (2 minutes)
1. Go to [AWS S3 Console](https://s3.console.aws.amazon.com/)
2. Click `media.orincore.com` → Permissions → CORS
3. Paste this:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
    "AllowedOrigins": ["http://localhost:8081", "https://circle.orincore.com"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

---

## ✅ Test It!

```bash
# Restart backend
npm run dev

# Test upload (replace YOUR_JWT_TOKEN)
curl -X POST http://localhost:8080/api/upload/profile-photo \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "photo=@/path/to/image.jpg"
```

**Expected Response:**
```json
{
  "success": true,
  "url": "https://media.orincore.com/Circle/avatars/{userId}/avatar-1234567890.jpg",
  "message": "Profile photo uploaded successfully"
}
```

---

## 📱 Use in Frontend

```jsx
import ProfilePhotoUpload from '../components/ProfilePhotoUpload'

function ProfileScreen() {
  return (
    <ProfilePhotoUpload
      currentPhotoUrl={user?.profilePhotoUrl}
      onUploadSuccess={(url) => console.log('New photo:', url)}
    />
  )
}
```

---

## 📚 Full Documentation

- **S3_SETUP.md** - Complete setup guide
- **S3_FOLDER_STRUCTURE.md** - Detailed folder documentation
- **UPDATED_S3_CONFIGURATION.md** - Configuration reference

---

## 🆘 Troubleshooting

**"Cannot find module 'multer'"**
```bash
npm install multer @types/multer
```

**"S3 is not configured"**
- Check `.env` has all AWS variables
- Restart backend server

**"Access Denied"**
- Verify IAM user has permissions
- Check bucket CORS configuration

---

## 🎉 Done!

Your S3 integration is ready. Files will be organized like this:

```
User uploads profile photo
  ↓
Circle/avatars/550e8400-e29b-41d4-a716-446655440000/avatar-1696234567890.jpg
  ↓
Public URL: https://media.orincore.com/Circle/avatars/550e8400-.../avatar-....jpg
```

Happy uploading! 🚀
