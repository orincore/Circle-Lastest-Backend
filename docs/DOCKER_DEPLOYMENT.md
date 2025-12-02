# Circle Backend - Docker Deployment Guide

## 🏗️ Architecture Overview

This deployment architecture is optimized for an **8GB RAM / 2 vCPU** instance and can handle thousands of concurrent users.

```
┌─────────────────────────────────────────────────────────────────┐
│                         NGINX (Port 80/443)                      │
│                    Load Balancer & Reverse Proxy                 │
│                         ~50-100MB RAM                            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   API Server    │ │  Socket.IO      │ │     Redis       │
│   (Port 8080)   │ │  (Port 8081)    │ │   (Port 6379)   │
│   ~1-1.5GB RAM  │ │   ~1-1.5GB RAM  │ │   ~256MB RAM    │
│   PM2 Cluster   │ │   Single + Redis│ │   Cache + Pub/Sub│
└─────────────────┘ └─────────────────┘ └─────────────────┘
          │               │               │
          └───────────────┼───────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Matchmaking    │ │  Cron Worker    │ │   Supabase      │
│    Worker       │ │  (Scheduled)    │ │   (External)    │
│   ~200-400MB    │ │   ~200-300MB    │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## 📦 Container Services

| Service | RAM | CPU | Purpose |
|---------|-----|-----|---------|
| **nginx** | 50-100MB | 0.25 | Reverse proxy, load balancing, SSL, rate limiting |
| **api** | 1-1.5GB | 1.0 | REST API, GraphQL, authentication |
| **socket** | 1-1.5GB | 1.0 | WebSocket connections, real-time chat |
| **redis** | 256MB | 0.25 | Caching, pub/sub, session storage |
| **matchmaking** | 200-400MB | 0.25 | Background matchmaking processing |
| **cron** | 200-300MB | 0.25 | Scheduled tasks (blind dating, cleanup) |

**Total: ~4-5GB RAM** (leaves headroom for spikes)

## 🚀 Quick Start

### 1. Server Setup (First Time Only)

```bash
# SSH into your server
ssh user@your-server-ip

# Clone the repository
git clone https://github.com/your-repo/circle-backend.git /opt/circle
cd /opt/circle/Backend

# Run server setup script (as root)
sudo ./scripts/server-setup.sh
```

### 2. Configure Environment

```bash
# Copy example environment file
cp .env.production.example .env.production

# Edit with your values
nano .env.production
```

### 3. Deploy

```bash
# Deploy all services
./scripts/docker-deploy.sh deploy

# Check status
./scripts/docker-deploy.sh status
```

## 📋 Deployment Commands

```bash
# Full deployment with zero-downtime
./scripts/docker-deploy.sh deploy

# Check service status
./scripts/docker-deploy.sh status

# View logs (all services)
./scripts/docker-deploy.sh logs

# View logs (specific service)
./scripts/docker-deploy.sh logs api
./scripts/docker-deploy.sh logs socket

# Stop all services
./scripts/docker-deploy.sh stop

# Rollback to previous version
./scripts/docker-deploy.sh rollback

# Build images locally
./scripts/docker-deploy.sh build
```

## 🔧 Manual Docker Commands

```bash
# Start all services
docker-compose -f docker-compose.production.yml up -d

# Restart specific service
docker-compose -f docker-compose.production.yml restart api

# Scale socket servers (if needed)
docker-compose -f docker-compose.production.yml up -d --scale socket=2

# View resource usage
docker stats

# View logs
docker-compose -f docker-compose.production.yml logs -f api

# Execute command in container
docker-compose -f docker-compose.production.yml exec api sh

# Rebuild and restart
docker-compose -f docker-compose.production.yml up -d --build api
```

## 🔄 Zero-Downtime Deployment

The deployment process follows these steps:

1. **Pull new images** - Downloads latest versions
2. **Deploy API** - Updates API container, waits for health check
3. **Deploy Socket** - Updates Socket container, waits for health check
4. **Deploy Workers** - Updates matchmaking and cron workers
5. **Reload NGINX** - Applies any config changes
6. **Cleanup** - Removes old images

During deployment:
- NGINX continues routing to healthy containers
- New containers start before old ones stop
- Health checks ensure services are ready before traffic is routed

## 📊 Monitoring

### Health Checks

```bash
# API health
curl http://localhost/health

# Direct container health
docker-compose -f docker-compose.production.yml exec api curl http://localhost:8080/health
```

### Resource Monitoring

```bash
# Real-time container stats
docker stats

# System resources
htop

# Disk usage
df -h

# Network connections
netstat -tulpn
```

### Logs

```bash
# All logs
docker-compose -f docker-compose.production.yml logs -f

# Specific service with timestamps
docker-compose -f docker-compose.production.yml logs -f --timestamps api

# Last 100 lines
docker-compose -f docker-compose.production.yml logs --tail=100 api
```

## 🔒 SSL/HTTPS Setup

### Using Let's Encrypt (Recommended)

```bash
# Install certbot
apt-get install certbot

# Get certificate
certbot certonly --standalone -d api.circle.orincore.com

# Copy certificates
cp /etc/letsencrypt/live/api.circle.orincore.com/fullchain.pem /opt/circle/docker/ssl/
cp /etc/letsencrypt/live/api.circle.orincore.com/privkey.pem /opt/circle/docker/ssl/

# Update nginx.conf to enable HTTPS block
# Then restart nginx
docker-compose -f docker-compose.production.yml restart nginx
```

### Auto-Renewal

```bash
# Add to crontab
0 0 1 * * certbot renew --quiet && docker-compose -f /opt/circle/docker-compose.production.yml exec nginx nginx -s reload
```

## 🔧 Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose -f docker-compose.production.yml logs api

# Check container status
docker-compose -f docker-compose.production.yml ps

# Inspect container
docker inspect circle-api
```

### High Memory Usage

```bash
# Check per-container memory
docker stats --no-stream

# Restart specific service
docker-compose -f docker-compose.production.yml restart api

# Clear Redis cache if needed
docker-compose -f docker-compose.production.yml exec redis redis-cli FLUSHALL
```

### Connection Issues

```bash
# Check if services are listening
netstat -tulpn | grep -E '(80|443|8080|8081|6379)'

# Test internal connectivity
docker-compose -f docker-compose.production.yml exec api ping redis

# Check NGINX config
docker-compose -f docker-compose.production.yml exec nginx nginx -t
```

### Redis Issues

```bash
# Connect to Redis CLI
docker-compose -f docker-compose.production.yml exec redis redis-cli

# Check memory usage
docker-compose -f docker-compose.production.yml exec redis redis-cli INFO memory

# Monitor commands
docker-compose -f docker-compose.production.yml exec redis redis-cli MONITOR
```

## 📈 Scaling Guide

### Vertical Scaling (More Resources)

If you upgrade to a larger instance:

1. Update `docker-compose.production.yml` resource limits
2. Increase PM2 instances in ecosystem configs
3. Increase Redis `maxmemory`

### Horizontal Scaling (Multiple Servers)

For very high traffic:

1. Use external Redis (AWS ElastiCache, Redis Cloud)
2. Run multiple API/Socket containers behind load balancer
3. Use Redis adapter for Socket.IO scaling
4. Consider Kubernetes for orchestration

## 🔐 Security Checklist

- [ ] Change default passwords
- [ ] Enable SSL/HTTPS
- [ ] Configure firewall (UFW)
- [ ] Use strong JWT secrets
- [ ] Enable rate limiting
- [ ] Regular security updates
- [ ] Backup Redis data
- [ ] Monitor for anomalies

## 📁 File Structure

```
Backend/
├── docker/
│   ├── Dockerfile.api          # API server image
│   ├── Dockerfile.socket       # Socket.IO server image
│   ├── Dockerfile.matchmaking  # Matchmaking worker image
│   ├── Dockerfile.cron         # Cron worker image
│   ├── nginx.conf              # NGINX configuration
│   ├── ecosystem.api.config.cjs
│   ├── ecosystem.socket.config.cjs
│   ├── ecosystem.matchmaking.config.cjs
│   ├── crontab                 # Cron job definitions
│   └── cron-entrypoint.sh
├── docker-compose.production.yml
├── .env.production.example
├── scripts/
│   ├── docker-deploy.sh        # Deployment script
│   └── server-setup.sh         # Server setup script
└── Jenkinsfile                 # CI/CD pipeline
```

## 🆘 Support

For issues:
1. Check logs: `./scripts/docker-deploy.sh logs`
2. Check status: `./scripts/docker-deploy.sh status`
3. Review this documentation
4. Check GitHub issues
