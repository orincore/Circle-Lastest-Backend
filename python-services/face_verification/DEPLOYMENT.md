# Face Verification Service - Deployment Guide

## 🚀 Quick Start (Linux Server)

### One-Command Installation

```bash
cd /path/to/Backend/python-services/face_verification
./install-all.sh
```

This interactive script will:
1. Install Python 3.11
2. Install system dependencies (OpenCV, MediaPipe)
3. Create virtual environment
4. Install Python packages
5. Configure AWS credentials
6. Start the service with PM2

## 📋 Available Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `install-all.sh` | Complete installation | `./install-all.sh` |
| `setup.sh` | Install dependencies only | `./setup.sh` |
| `start.sh` | Start manually (dev) | `./start.sh` |
| `start-pm2.sh` | Start with PM2 (prod) | `./start-pm2.sh` |
| `stop.sh` | Stop PM2 service | `./stop.sh` |

## 🔧 Manual Installation Steps

### 1. Install Python 3.11

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y software-properties-common
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt-get update
sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
```

**CentOS/RHEL:**
```bash
sudo yum install -y python3.11 python3.11-devel
```

### 2. Install System Dependencies

```bash
sudo apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1
```

### 3. Create Virtual Environment

```bash
python3.11 -m venv venv
source venv/bin/activate
```

### 4. Install Python Packages

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

### 5. Configure Environment

```bash
cp .env.example .env
nano .env
```

Add your AWS credentials:
```env
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=ap-south-1
S3_BUCKET_NAME=circle-verification-videos
```

### 6. Create S3 Bucket

```bash
aws s3 mb s3://circle-verification-videos --region ap-south-1
```

Or via AWS Console:
1. Go to S3
2. Create bucket: `circle-verification-videos`
3. Region: `ap-south-1`
4. Keep default settings

### 7. Start Service

**Development:**
```bash
source venv/bin/activate
python app.py
```

**Production (PM2):**
```bash
./start-pm2.sh
```

## 🔄 PM2 Management

### Start Service
```bash
pm2 start app.py --name face-verification --interpreter ./venv/bin/python
```

### View Status
```bash
pm2 status
```

### View Logs
```bash
pm2 logs face-verification
```

### Restart Service
```bash
pm2 restart face-verification
```

### Stop Service
```bash
pm2 stop face-verification
```

### Remove from PM2
```bash
pm2 delete face-verification
```

### Auto-start on Boot
```bash
pm2 startup
pm2 save
```

## 🧪 Testing

### Health Check
```bash
curl http://localhost:5000/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "face-verification"
}
```

### Test Verification (with video file)
```bash
curl -X POST http://localhost:5000/verify \
  -F "video=@test_video.mp4" \
  -F "user_id=test123"
```

## 🔒 Security Considerations

1. **Firewall**: Service runs on port 5000 (internal only)
   ```bash
   # Don't expose to public - only allow from Node.js backend
   sudo ufw allow from 127.0.0.1 to any port 5000
   ```

2. **AWS Credentials**: Store securely in `.env`, never commit
   ```bash
   chmod 600 .env
   ```

3. **S3 Bucket**: Configure proper IAM permissions
   - Allow: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`
   - Resource: `arn:aws:s3:::circle-verification-videos/*`

## 📊 Monitoring

### Check Service Status
```bash
pm2 status face-verification
```

### View Resource Usage
```bash
pm2 monit
```

### View Logs
```bash
# Real-time logs
pm2 logs face-verification --lines 100

# Error logs only
pm2 logs face-verification --err

# Save logs to file
pm2 logs face-verification > logs.txt
```

## 🐛 Troubleshooting

### Service Won't Start

**Check Python version:**
```bash
python3.11 --version
```

**Check virtual environment:**
```bash
source venv/bin/activate
python --version  # Should be 3.11.x
```

**Check dependencies:**
```bash
pip list | grep mediapipe
pip list | grep opencv
```

### Import Errors

**Reinstall dependencies:**
```bash
source venv/bin/activate
pip install --force-reinstall -r requirements.txt
```

### S3 Upload Fails

**Check AWS credentials:**
```bash
aws s3 ls s3://circle-verification-videos
```

**Check IAM permissions:**
- Ensure IAM user has S3 access
- Verify bucket name is correct
- Check region matches

### Port Already in Use

**Find process using port 5000:**
```bash
sudo lsof -i :5000
```

**Kill process:**
```bash
sudo kill -9 <PID>
```

### Memory Issues

**Increase PM2 memory limit:**
```bash
pm2 start app.py \
  --name face-verification \
  --interpreter ./venv/bin/python \
  --max-memory-restart 2G
```

## 🔄 Updates

### Update Code
```bash
cd /path/to/face_verification
git pull
source venv/bin/activate
pip install -r requirements.txt
pm2 restart face-verification
```

### Update Dependencies
```bash
source venv/bin/activate
pip install --upgrade -r requirements.txt
pm2 restart face-verification
```

## 📝 Integration with Node.js Backend

Update Node.js backend `.env`:
```env
PYTHON_VERIFICATION_URL=http://localhost:5000
```

The Node.js backend will call:
```typescript
const response = await axios.post('http://localhost:5000/verify', formData);
```

## 🌐 Production Checklist

- [ ] Python 3.11 installed
- [ ] Virtual environment created
- [ ] Dependencies installed
- [ ] AWS credentials configured
- [ ] S3 bucket created
- [ ] Service started with PM2
- [ ] PM2 auto-start enabled
- [ ] Firewall configured (internal only)
- [ ] Health check passing
- [ ] Logs monitored
- [ ] Node.js backend connected

## 📞 Support

For issues:
1. Check logs: `pm2 logs face-verification`
2. Verify health: `curl http://localhost:5000/health`
3. Check system resources: `pm2 monit`
4. Review error messages in logs
