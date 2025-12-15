# Quick Start - ML Matching Service

## Prerequisites
- Docker and Docker Compose installed
- PostgreSQL database (Supabase) configured
- Node.js backend running

## 1. Environment Setup

```bash
# Add to .env.production
echo "ML_SERVICE_URL=http://ml-matching:8090" >> .env.production
echo "INTERNAL_API_KEY=$(openssl rand -hex 32)" >> .env.production
echo "DATABASE_URL=your-postgresql-connection-string" >> .env.production
```

## 2. Test Offline (Optional)

```bash
cd python-services/ml-matching

# Make start script executable
chmod +x start.sh

# Run the service locally
./start.sh

# In another terminal, test it
python test_service.py
```

## 3. Deploy with Docker

```bash
# From Circle-Lastest-Backend directory
docker-compose -f docker-compose.production.yml build ml-matching
docker-compose -f docker-compose.production.yml up -d ml-matching

# Check logs
docker-compose -f docker-compose.production.yml logs -f ml-matching
```

## 4. Verify

```bash
# Health check
curl http://localhost:8090/health

# Through nginx
curl https://api.circle.orincore.com/api/ml/health
```

## 5. Use in Your App

```typescript
// Example: Search for matches with a prompt
const response = await fetch('/api/ml-matching/prompt-search', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${userToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: "Looking for someone who loves hiking and photography",
    latitude: 28.6139,
    longitude: 77.2090,
    max_distance: 50,
    age_range: [25, 35],
    limit: 10
  })
});

const { matches } = await response.json();
```

## Troubleshooting

**Service won't start?**
- Check `docker-compose logs ml-matching`
- Verify DATABASE_URL is correct
- Ensure INTERNAL_API_KEY is set

**No matches returned?**
- Verify database has user profiles
- Check user exists in database
- Review logs for errors

**Need help?**
- See `DEPLOYMENT_ML_MATCHING.md` for full guide
- See `python-services/ml-matching/README.md` for API docs
