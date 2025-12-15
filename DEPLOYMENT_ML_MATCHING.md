# ML Matching Service - Deployment Guide

This guide covers the deployment of the new Python ML Matching service alongside the existing Node.js backend.

## Overview

The ML Matching service is a Python-based FastAPI application that provides intelligent user matching using machine learning algorithms. It runs as a separate Docker container and communicates with the Node.js backend via internal HTTP APIs.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         NGINX                                │
│              (Reverse Proxy & Load Balancer)                 │
└───────┬─────────────────────────────────────────┬───────────┘
        │                                         │
        │ /api/*                                  │ /api/ml/*
        │                                         │
┌───────▼─────────────────┐              ┌────────▼──────────┐
│   Node.js API Servers   │              │  Python ML Service │
│   (Blue/Green Deploy)   │◄────────────►│   (FastAPI)        │
│                         │   Internal   │                    │
│  - Express API          │   HTTP API   │  - ML Matching     │
│  - Socket.IO            │              │  - NLP Processing  │
│  - Matchmaking          │              │  - Scoring Engine  │
└─────────┬───────────────┘              └────────┬───────────┘
          │                                       │
          │                                       │
          └───────────────┬───────────────────────┘
                          │
                  ┌───────▼────────┐
                  │   PostgreSQL   │
                  │   (Supabase)   │
                  └────────────────┘
```

## Files Created

### Python Service
- `python-services/ml-matching/app.py` - FastAPI application
- `python-services/ml-matching/requirements.txt` - Python dependencies
- `python-services/ml-matching/.env.example` - Environment template
- `python-services/ml-matching/test_service.py` - Standalone test script
- `python-services/ml-matching/README.md` - Service documentation
- `python-services/ml-matching/.gitignore` - Git ignore rules

### Docker Configuration
- `docker/Dockerfile.ml-matching` - Python service Dockerfile
- Updated `docker-compose.production.yml` - Added ml-matching service
- Updated `docker/nginx.conf` - Added ML service routing

### Node.js Integration
- `src/server/services/ml-matching.service.ts` - TypeScript client for Python service
- `src/server/routes/ml-matching.routes.ts` - Express routes for ML matching
- Updated `src/server/app.ts` - Registered ML matching routes

## Environment Variables

Add these to your `.env.production` file:

```bash
# ML Matching Service
ML_SERVICE_URL=http://ml-matching:8090
INTERNAL_API_KEY=your-secure-api-key-here

# Database URL (already exists, ensure it's set)
DATABASE_URL=postgresql://user:password@host:port/database
```

## Deployment Steps

### 1. First-Time Setup

```bash
# Navigate to backend directory
cd Circle-Lastest-Backend

# Copy environment file for ML service
cp python-services/ml-matching/.env.example python-services/ml-matching/.env

# Edit the .env file with your configuration
nano python-services/ml-matching/.env

# Ensure .env.production has ML_SERVICE_URL and INTERNAL_API_KEY
nano .env.production
```

### 2. Build and Deploy

```bash
# Build all services including the new ML matching service
docker-compose -f docker-compose.production.yml build

# Start all services
docker-compose -f docker-compose.production.yml up -d

# Check service status
docker-compose -f docker-compose.production.yml ps

# View logs
docker-compose -f docker-compose.production.yml logs -f ml-matching
```

### 3. Verify Deployment

```bash
# Check ML service health
curl http://localhost:8090/health

# Or through nginx (if configured)
curl https://api.circle.orincore.com/api/ml/health

# Check all services
docker-compose -f docker-compose.production.yml ps
```

## Testing

### Offline Testing (Before Deployment)

```bash
# Navigate to ML service directory
cd python-services/ml-matching

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Set environment variables
export DATABASE_URL="your-database-url"
export INTERNAL_API_KEY="your-api-key"
export SERVICE_PORT=8090

# Run the service
python app.py

# In another terminal, run tests
python test_service.py
```

### Production Testing

```bash
# Test health endpoint
curl https://api.circle.orincore.com/api/ml/health

# Test matching endpoint (requires authentication)
curl -X POST https://api.circle.orincore.com/api/ml-matching/search \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Looking for someone who loves hiking",
    "preferences": {
      "max_distance": 50,
      "age_range": [25, 35]
    },
    "limit": 10
  }'
```

## API Endpoints

### Internal Python Service (ml-matching:8090)

- `GET /health` - Health check
- `POST /api/ml/match` - Find matches (requires X-API-Key header)

### Public Node.js API (via nginx)

- `GET /api/ml-matching/health` - ML service health check
- `POST /api/ml-matching/search` - General ML-based search (requires auth)
- `POST /api/ml-matching/prompt-search` - Prompt-based search (requires auth)

## Monitoring

### Check Service Logs

```bash
# ML matching service logs
docker-compose -f docker-compose.production.yml logs -f ml-matching

# All services logs
docker-compose -f docker-compose.production.yml logs -f

# Last 100 lines
docker-compose -f docker-compose.production.yml logs --tail=100 ml-matching
```

### Check Resource Usage

```bash
# Container stats
docker stats circle-ml-matching

# All containers
docker stats
```

### Health Checks

```bash
# Check if service is healthy
docker inspect circle-ml-matching | grep -A 5 Health

# Manual health check
curl http://localhost:8090/health
```

## Troubleshooting

### Service Won't Start

1. Check logs:
   ```bash
   docker-compose -f docker-compose.production.yml logs ml-matching
   ```

2. Verify environment variables:
   ```bash
   docker exec circle-ml-matching env | grep -E 'DATABASE_URL|INTERNAL_API_KEY'
   ```

3. Check database connectivity:
   ```bash
   docker exec circle-ml-matching python -c "import asyncpg; print('asyncpg installed')"
   ```

### No Matches Returned

1. Verify database has user profiles
2. Check user_id exists in database
3. Review match score threshold (minimum 10%)
4. Check logs for errors

### Performance Issues

1. Increase database connection pool size in `app.py`
2. Add database indexes on commonly queried fields
3. Increase number of workers in Dockerfile CMD
4. Monitor resource usage with `docker stats`

## Rollback Procedure

If you need to rollback the ML matching service:

```bash
# Stop and remove ML matching container
docker-compose -f docker-compose.production.yml stop ml-matching
docker-compose -f docker-compose.production.yml rm -f ml-matching

# The existing API and socket services will continue to work
# as they don't depend on the ML service
```

## CI/CD Integration

The service will be automatically deployed when you commit changes. The Jenkins pipeline will:

1. Detect changes in `python-services/ml-matching/` or `docker/Dockerfile.ml-matching`
2. Build the new Docker image
3. Deploy using blue-green strategy
4. Run health checks
5. Route traffic to new container

## Performance Metrics

Expected performance:
- Average response time: < 100ms for 100 candidates
- Memory usage: 150-300MB per worker
- CPU usage: Low to medium (0.25 CPU limit)
- Concurrent requests: Supports 2 workers by default

## Security

- API key authentication for all match endpoints
- Non-root user in Docker container
- No external network access required
- Internal service communication only
- Rate limiting via nginx (20 req/s)

## Scaling

To scale the ML matching service:

1. Increase workers in Dockerfile:
   ```dockerfile
   CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "4"]
   ```

2. Increase resource limits in docker-compose.production.yml:
   ```yaml
   resources:
     limits:
       memory: 512M
       cpus: '0.5'
   ```

3. Add multiple instances with load balancing in nginx.conf

## Future Enhancements

- [ ] Advanced NLP with transformers (BERT, sentence-transformers)
- [ ] Collaborative filtering based on user interactions
- [ ] Real-time learning from match success rates
- [ ] Vector embeddings for semantic search
- [ ] GPU acceleration for large-scale matching
- [ ] Redis caching layer
- [ ] A/B testing framework

## Support

For issues or questions:
1. Check logs first
2. Review this documentation
3. Check Python service README: `python-services/ml-matching/README.md`
4. Contact DevOps team
