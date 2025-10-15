# Face Verification Service

Python-based face verification service using MediaPipe for head movement detection.

## Features

- Real-time face detection using MediaPipe
- Head pose estimation (yaw, pitch, roll)
- Movement verification (left, right, up, down)
- S3 integration for video storage
- Automatic video deletion on successful verification

## Setup

### Quick Install (Linux Server)

**One-command installation:**
```bash
cd python-services/face_verification
./install-all.sh
```

This will:
- Install Python 3.11
- Create virtual environment
- Install all dependencies
- Configure environment
- Start the service

### Manual Setup

1. **Run Setup Script**
```bash
./setup.sh
```

2. **Configure Environment**
```bash
cp .env.example .env
nano .env  # Edit with your AWS credentials
```

3. **Start Service**

**Development (manual):**
```bash
./start.sh
```

**Production (with PM2):**
```bash
./start-pm2.sh
```

**Stop Service:**
```bash
./stop.sh
```

Service runs on `http://localhost:5000`

### macOS Setup

```bash
brew install python@3.11
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

## API Endpoints

### POST /verify
Verify face from video

**Request:**
- Content-Type: multipart/form-data
- Fields:
  - `video`: Video file (MP4)
  - `user_id`: User ID string

**Response:**
```json
{
  "verified": true,
  "confidence": 0.9,
  "movements_detected": ["left", "right", "up", "down"],
  "movements_required": ["left", "right", "up", "down"],
  "face_detection_rate": 0.95,
  "total_frames": 120,
  "face_frames": 114,
  "video_deleted": true,
  "reason": "Verification successful"
}
```

### POST /delete-video
Delete verification video from S3

**Request:**
```json
{
  "s3_key": "verification-videos/user123/video.mp4"
}
```

### GET /health
Health check

## Integration with Node.js Backend

The Node.js backend calls this service internally:

```typescript
const response = await axios.post('http://localhost:5000/verify', formData, {
  headers: { 'Content-Type': 'multipart/form-data' }
});
```

## Production Deployment

Use PM2 or systemd to run as a service:

```bash
pm2 start app.py --name face-verification --interpreter python3
```
