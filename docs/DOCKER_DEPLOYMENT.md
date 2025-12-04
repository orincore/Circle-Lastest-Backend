# Circle Backend - Docker Deployment Guide

## 🏗️ Architecture Overview

This deployment architecture uses **Blue-Green deployment** for zero-downtime updates, optimized for an **8GB RAM / 2 vCPU** instance.

### Key Features
- **Zero-downtime deployments** - Rolling updates with no service interruption
- **Load balancing** - Traffic distributed across both Blue and Green sets
- **Automatic failover** - If one set fails, traffic routes to the healthy set
- **Efficient resource usage** - Optimized for 8GB RAM with ~2.8GB buffer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           NGINX (Port 80/443)                            │
│                      Load Balancer & Reverse Proxy                       │
│                           ~50-100MB RAM                                  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         BLUE SET                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │   API Blue      │  │  Socket Blue    │  │ Matchmaking Blue│          │
│  │   (Port 8080)   │  │  (Port 8081)    │  │                 │          │
│  │   ~768MB RAM    │  │   ~768MB RAM    │  │   ~256MB RAM    │          │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         GREEN SET                                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │   API Green     │  │  Socket Green   │  │ Matchmaking Green│         │
│  │   (Port 8080)   │  │  (Port 8081)    │  │                 │          │
│  │   ~768MB RAM    │  │   ~768MB RAM    │  │   ~256MB RAM    │          │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│     Redis       │  │  Cron Worker    │  │   Supabase      │
│  (Port 6379)    │  │  (Single)       │  │   (External)    │
│   ~256MB RAM    │  │   ~256MB RAM    │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## 📦 Container Services

| Service | RAM | CPU | Purpose |
|---------|-----|-----|---------|
| **nginx** | 50-100MB | 0.25 | Reverse proxy, load balancing, SSL, rate limiting |
| **api-blue** | 768MB | 0.5 | REST API, GraphQL, authentication (Blue set) |
| **api-green** | 768MB | 0.5 | REST API, GraphQL, authentication (Green set) |
| **socket-blue** | 768MB | 0.5 | WebSocket connections, real-time chat (Blue set) |
| **socket-green** | 768MB | 0.5 | WebSocket connections, real-time chat (Green set) |
| **redis** | 256MB | 0.25 | Caching, pub/sub, session storage (shared) |
| **matchmaking-blue** | 256MB | 0.15 | Background matchmaking (Blue set) |
| **matchmaking-green** | 256MB | 0.15 | Background matchmaking (Green set) |
| **cron** | 256MB | 0.15 | Scheduled tasks (single instance) |

**Total: ~5.2GB RAM** (leaves ~2.8GB headroom for spikes and OS)

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

### Basic Commands

```bash
# Full deployment with rolling update
./scripts/docker-deploy.sh deploy

# Quick update (services only, faster)
./scripts/docker-deploy.sh quick-update

# Check service status and health
./scripts/docker-deploy.sh status

# View logs (all services)
./scripts/docker-deploy.sh logs

# View logs (specific service)
./scripts/docker-deploy.sh logs api-blue
./scripts/docker-deploy.sh logs socket-green

# Stop all services
./scripts/docker-deploy.sh stop

# Build images locally
./scripts/docker-deploy.sh build
```

### Blue-Green Specific Commands

```bash
# Deploy only the blue set
./scripts/docker-deploy.sh deploy-blue

# Deploy only the green set
./scripts/docker-deploy.sh deploy-green

# Rollback both sets to previous version
./scripts/docker-deploy.sh rollback v1.2.3

# Rollback only blue set
./scripts/docker-deploy.sh rollback v1.2.3 blue

# Take blue set offline for maintenance
./scripts/docker-deploy.sh scale blue down

# Bring blue set back online
./scripts/docker-deploy.sh scale blue up

# Deploy with specific tag
TAG=v1.0.0 ./scripts/docker-deploy.sh deploy
```

## 🔧 Manual Docker Commands

```bash
# Start all services
docker-compose -f docker-compose.production.yml up -d

# Restart specific service
docker-compose -f docker-compose.production.yml restart api-blue

# View resource usage
docker stats

# View logs
docker-compose -f docker-compose.production.yml logs -f api-blue

# Execute command in container
docker-compose -f docker-compose.production.yml exec api-blue sh

# Rebuild and restart specific service
docker-compose -f docker-compose.production.yml up -d --build api-green
```

## 🔄 Zero-Downtime Deployment (Blue-Green)

### How It Works

The deployment uses a **rolling update** strategy:

1. **Check Health** - Verify which sets are currently healthy
2. **Update Blue Set** - Green set handles all traffic
   - Deploy api-blue, socket-blue, matchmaking-blue
   - Wait for health checks to pass
3. **Update Green Set** - Blue set handles all traffic
   - Deploy api-green, socket-green, matchmaking-green
   - Wait for health checks to pass
4. **Update Cron** - Single instance, quick restart
5. **Reload NGINX** - Apply any config changes
6. **Cleanup** - Remove old Docker images

### Traffic Flow During Update

```
Normal Operation:
  Traffic → NGINX → [Blue 50%] + [Green 50%]

During Blue Update:
  Traffic → NGINX → [Green 100%] (Blue updating...)

During Green Update:
  Traffic → NGINX → [Blue 100%] (Green updating...)

After Update:
  Traffic → NGINX → [Blue 50%] + [Green 50%]
```

### Benefits

- **Zero downtime** - One set always handles traffic
- **Instant rollback** - Just restart the previous version
- **Load distribution** - Both sets share traffic normally
- **Automatic failover** - NGINX routes around failed containers

## 📊 Monitoring

### Health Checks

```bash
# API health
curl http://localhost/health

# Direct container health (blue)
docker-compose -f docker-compose.production.yml exec api-blue curl http://localhost:8080/health

# Direct container health (green)
docker-compose -f docker-compose.production.yml exec api-green curl http://localhost:8080/health

# Check all service health at once
./scripts/docker-deploy.sh status
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
docker-compose -f docker-compose.production.yml logs -f --timestamps api-blue

# Last 100 lines from both API containers
docker-compose -f docker-compose.production.yml logs --tail=100 api-blue api-green

# Compare blue vs green logs
docker-compose -f docker-compose.production.yml logs --tail=50 api-blue &
docker-compose -f docker-compose.production.yml logs --tail=50 api-green
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
# Check logs for specific container
docker-compose -f docker-compose.production.yml logs api-blue
docker-compose -f docker-compose.production.yml logs api-green

# Check container status
docker-compose -f docker-compose.production.yml ps

# Inspect container
docker inspect circle-api-blue
docker inspect circle-api-green
```

### High Memory Usage

```bash
# Check per-container memory
docker stats --no-stream

# Restart specific service (traffic shifts to other set)
docker-compose -f docker-compose.production.yml restart api-blue

# Restart entire color set
./scripts/docker-deploy.sh scale blue down
./scripts/docker-deploy.sh scale blue up

# Clear Redis cache if needed
docker-compose -f docker-compose.production.yml exec redis redis-cli FLUSHALL
```

### One Set Unhealthy

```bash
# Check which set is unhealthy
./scripts/docker-deploy.sh status

# Redeploy only the unhealthy set
./scripts/docker-deploy.sh deploy-blue   # or deploy-green

# Traffic automatically routes to healthy set
```

### Connection Issues

```bash
# Check if services are listening
netstat -tulpn | grep -E '(80|443|8080|8081|6379)'

# Test internal connectivity
docker-compose -f docker-compose.production.yml exec api-blue ping redis

# Check NGINX config
docker-compose -f docker-compose.production.yml exec nginx nginx -t

# Check NGINX upstream status
docker-compose -f docker-compose.production.yml exec nginx cat /var/log/nginx/error.log | tail -20
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
│   ├── Dockerfile.api          # API server image (used by blue & green)
│   ├── Dockerfile.socket       # Socket.IO server image (used by blue & green)
│   ├── Dockerfile.matchmaking  # Matchmaking worker image (used by blue & green)
│   ├── Dockerfile.cron         # Cron worker image
│   ├── nginx.conf              # NGINX config with blue-green load balancing
│   ├── ecosystem.api.config.cjs
│   ├── ecosystem.socket.config.cjs
│   ├── ecosystem.matchmaking.config.cjs
│   ├── crontab                 # Cron job definitions
│   └── cron-entrypoint.sh
├── docker-compose.production.yml  # Blue-green deployment config
├── .env.production.example
├── scripts/
│   ├── docker-deploy.sh        # Blue-green deployment script
│   └── server-setup.sh         # Server setup script
└── Jenkinsfile                 # CI/CD pipeline
```

## 🎯 Blue-Green Deployment Quick Reference

| Command | Description |
|---------|-------------|
| `./scripts/docker-deploy.sh deploy` | Full deployment with rolling update |
| `./scripts/docker-deploy.sh quick-update` | Fast rolling update (services only) |
| `./scripts/docker-deploy.sh deploy-blue` | Update only blue set |
| `./scripts/docker-deploy.sh deploy-green` | Update only green set |
| `./scripts/docker-deploy.sh scale blue down` | Take blue offline |
| `./scripts/docker-deploy.sh scale blue up` | Bring blue online |
| `./scripts/docker-deploy.sh rollback v1.0.0` | Rollback to version |
| `./scripts/docker-deploy.sh status` | Show health of all sets |

## 🆘 Support

For issues:
1. Check logs: `./scripts/docker-deploy.sh logs`
2. Check status: `./scripts/docker-deploy.sh status`
3. Review this documentation
4. Check GitHub issues
