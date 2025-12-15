# ML Matching Service - Deployment Checklist

## Pre-Deployment Checklist

### ✅ Files Created

#### Python Service
- [x] `python-services/ml-matching/app.py` - FastAPI application (450+ lines)
- [x] `python-services/ml-matching/requirements.txt` - Dependencies
- [x] `python-services/ml-matching/.env.example` - Environment template
- [x] `python-services/ml-matching/test_service.py` - Test script
- [x] `python-services/ml-matching/start.sh` - Start script (executable)
- [x] `python-services/ml-matching/README.md` - Documentation
- [x] `python-services/ml-matching/.gitignore` - Git ignore

#### Docker Configuration
- [x] `docker/Dockerfile.ml-matching` - Python container
- [x] `docker-compose.production.yml` - Updated with ml-matching service
- [x] `docker/nginx.conf` - Updated with ML routing (3 locations added)

#### Node.js Integration
- [x] `src/server/services/ml-matching.service.ts` - TypeScript client
- [x] `src/server/routes/ml-matching.routes.ts` - Express routes
- [x] `src/server/app.ts` - Routes registered

#### Documentation
- [x] `DEPLOYMENT_ML_MATCHING.md` - Full deployment guide
- [x] `QUICK_START_ML.md` - Quick start guide
- [x] `ML_MATCHING_SUMMARY.md` - Implementation summary
- [x] `ML_DEPLOYMENT_CHECKLIST.md` - This file
- [x] `.env.production.example` - Updated with ML variables

## Environment Configuration

### Required Variables

Add to `.env.production`:

```bash
# ML Matching Service
ML_SERVICE_URL=http://ml-matching:8090
INTERNAL_API_KEY=<generate-with-openssl-rand-hex-32>
DATABASE_URL=postgresql://user:password@host:port/database
```

### Generate API Key
```bash
openssl rand -hex 32
```

## Testing Before Deployment

### 1. Offline Test (Recommended)

```bash
cd python-services/ml-matching

# Create .env file
cp .env.example .env
# Edit .env with your DATABASE_URL and INTERNAL_API_KEY

# Run service
./start.sh

# In another terminal, run tests
python test_service.py
```

**Expected Output:**
- ✓ Health Check - PASS
- ✓ Root Endpoint - PASS
- ✓ Match Endpoint (No Auth) - PASS (401 expected)
- ✓ Match Endpoint (With Auth) - PASS (200 or 404)
- ✓ Performance Test - PASS

### 2. Docker Build Test

```bash
# Test Docker build
docker-compose -f docker-compose.production.yml build ml-matching

# Check image was created
docker images | grep ml-matching
```

## Deployment Steps

### Step 1: Environment Setup
```bash
# Ensure .env.production has required variables
grep -E "ML_SERVICE_URL|INTERNAL_API_KEY|DATABASE_URL" .env.production
```

### Step 2: Build Services
```bash
docker-compose -f docker-compose.production.yml build
```

### Step 3: Deploy
```bash
docker-compose -f docker-compose.production.yml up -d
```

### Step 4: Verify Deployment
```bash
# Check all containers are running
docker-compose -f docker-compose.production.yml ps

# Check ML service specifically
docker ps | grep ml-matching

# View logs
docker-compose -f docker-compose.production.yml logs -f ml-matching
```

### Step 5: Health Checks
```bash
# Internal health check
curl http://localhost:8090/health

# Through nginx (if configured)
curl https://api.circle.orincore.com/api/ml/health

# Node.js integration health
curl https://api.circle.orincore.com/api/ml-matching/health
```

## Post-Deployment Verification

### 1. Service Status
```bash
# All services healthy?
docker-compose -f docker-compose.production.yml ps

# ML service logs clean?
docker-compose -f docker-compose.production.yml logs --tail=50 ml-matching
```

### 2. API Endpoints

Test with authenticated request:
```bash
curl -X POST https://api.circle.orincore.com/api/ml-matching/prompt-search \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Looking for hiking enthusiasts",
    "limit": 5
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "matches": [...],
  "count": 5
}
```

### 3. Resource Usage
```bash
# Check memory and CPU
docker stats circle-ml-matching

# Should be:
# - Memory: 150-300MB
# - CPU: <25%
```

### 4. Integration Test

Test from your frontend/mobile app:
- Search with prompt
- Verify matches returned
- Check match scores displayed
- Confirm response time <2s

## Monitoring Setup

### Logs
```bash
# Real-time logs
docker-compose -f docker-compose.production.yml logs -f ml-matching

# Last 100 lines
docker-compose -f docker-compose.production.yml logs --tail=100 ml-matching

# Search for errors
docker-compose -f docker-compose.production.yml logs ml-matching | grep -i error
```

### Metrics
```bash
# Container stats
docker stats circle-ml-matching

# Health endpoint
watch -n 5 'curl -s http://localhost:8090/health | jq'
```

## Rollback Plan

If issues occur:

```bash
# Stop ML service
docker-compose -f docker-compose.production.yml stop ml-matching

# Remove container
docker-compose -f docker-compose.production.yml rm -f ml-matching

# Existing services continue working normally
```

## Common Issues & Solutions

### Issue: Service won't start
**Check:**
```bash
docker-compose -f docker-compose.production.yml logs ml-matching
```
**Solutions:**
- Verify DATABASE_URL is correct
- Check INTERNAL_API_KEY is set
- Ensure port 8090 not in use

### Issue: No matches returned
**Check:**
- Database has user profiles
- User ID exists in database
- Match score threshold (min 10%)

**Debug:**
```bash
docker exec circle-ml-matching python -c "
import asyncio
import asyncpg
import os
async def test():
    pool = await asyncpg.create_pool(os.getenv('DATABASE_URL'))
    count = await pool.fetchval('SELECT COUNT(*) FROM profiles')
    print(f'Profiles in DB: {count}')
    await pool.close()
asyncio.run(test())
"
```

### Issue: Slow performance
**Solutions:**
- Increase workers in Dockerfile (change `--workers 2` to `--workers 4`)
- Increase memory limit in docker-compose.production.yml
- Add database indexes on commonly queried fields

## Success Criteria

- [ ] All containers running
- [ ] ML service health check returns 200
- [ ] Node.js can communicate with Python service
- [ ] Nginx routes /api/ml/* correctly
- [ ] Authenticated requests return matches
- [ ] Response time <2 seconds
- [ ] Memory usage 150-300MB
- [ ] No errors in logs
- [ ] Existing API/Socket endpoints unaffected

## Next Steps After Deployment

1. **Monitor for 24 hours**
   - Check logs regularly
   - Monitor resource usage
   - Track error rates

2. **Integrate in Frontend**
   - Add ML search UI
   - Display match scores
   - Show matching factors

3. **Gather Feedback**
   - Track match quality
   - Monitor user engagement
   - Collect user feedback

4. **Optimize**
   - Fine-tune scoring weights
   - Add more matching factors
   - Improve performance

## Support

- **Full Guide**: `DEPLOYMENT_ML_MATCHING.md`
- **Quick Start**: `QUICK_START_ML.md`
- **Summary**: `ML_MATCHING_SUMMARY.md`
- **Python Docs**: `python-services/ml-matching/README.md`

---

**Deployment Date**: _____________

**Deployed By**: _____________

**Status**: [ ] Success [ ] Issues [ ] Rolled Back

**Notes**:
_____________________________________________________________
_____________________________________________________________
_____________________________________________________________
