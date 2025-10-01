# AWS S3 Configuration for Profile Picture Upload

## Current Error

```
The AWS Access Key Id you provided does not exist in our records.
```

This means your backend `.env` file is missing valid AWS credentials.

---

## Quick Fix

### 1. Check Your Backend `.env` File

```bash
cd Backend
cat .env | grep AWS
```

You should see:
```env
AWS_REGION=us-east-1
AWS_S3_BUCKET=media.orincore.com
AWS_ACCESS_KEY_ID=your_actual_key_here
AWS_SECRET_ACCESS_KEY=your_actual_secret_here
```

### 2. Add Your AWS Credentials

Edit `Backend/.env` and add your AWS credentials:

```env
# AWS S3 Configuration
AWS_REGION=us-east-1
AWS_S3_BUCKET=media.orincore.com
AWS_ACCESS_KEY_ID=AKIA...your_key...
AWS_SECRET_ACCESS_KEY=your_secret_key_here
```

### 3. Restart Backend

```bash
cd Backend
npm run dev
```

### 4. Try Upload Again

The upload should now work!

---

## Where to Get AWS Credentials

### Option 1: AWS IAM Console

1. Go to: https://console.aws.amazon.com/iam/
2. Click "Users" → Your user
3. Click "Security credentials" tab
4. Click "Create access key"
5. Copy the Access Key ID and Secret Access Key
6. Add them to `Backend/.env`

### Option 2: Use Existing Credentials

If you already have AWS credentials for `media.orincore.com` bucket:
1. Find your existing credentials
2. Add them to `Backend/.env`
3. Restart backend

---

## Required IAM Permissions

Your AWS user needs these S3 permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::media.orincore.com/Circle/*"
    }
  ]
}
```

---

## Verify Backend Configuration

```bash
cd Backend

# Check if .env file exists
ls -la .env

# Check AWS variables (without showing secrets)
cat .env | grep AWS | sed 's/=.*/=***/'
```

Should show:
```
AWS_REGION=***
AWS_S3_BUCKET=***
AWS_ACCESS_KEY_ID=***
AWS_SECRET_ACCESS_KEY=***
```

---

## Test Backend S3 Connection

After adding credentials, test the backend:

```bash
cd Backend
npm run dev
```

Backend logs should show:
```
✅ S3 Service initialized
✅ Bucket: media.orincore.com
✅ Region: us-east-1
```

---

## Alternative: Use Production Backend

If you don't want to set up local AWS credentials, use production backend:

**Update `.env.development`**:
```env
EXPO_PUBLIC_API_BASE_URL=https://api.circle.orincore.com
EXPO_PUBLIC_WS_BASE_URL=https://api.circle.orincore.com
```

**Note**: This requires your production backend to accept file uploads from your test device.

---

## Summary

**Current Status**: ✅ Upload is working! Backend is receiving the file.

**Issue**: ❌ Backend can't upload to S3 (missing AWS credentials)

**Solution**: Add AWS credentials to `Backend/.env` file

Once you add the credentials and restart the backend, the upload will work perfectly! 🎉
