# Jenkins CI/CD - Quick Reference Guide

Quick commands and troubleshooting for day-to-day operations.

## 🚀 Quick Start

### Trigger Manual Build
```bash
# Via Jenkins UI
Jenkins → Circle-Backend-Deploy → Build with Parameters → Build
```

### Check Deployment Status
```bash
ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml ps"
```

### View Live Logs
```bash
ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml logs -f api"
```

---

## 🔧 Common Operations

### Restart Jenkins
```bash
sudo systemctl restart jenkins
```

### Restart Specific Service
```bash
ssh deploy@your-server-ip
cd /opt/circle/Backend
docker-compose -f docker-compose.production.yml restart api
```

### Restart All Services
```bash
ssh deploy@your-server-ip
cd /opt/circle/Backend
docker-compose -f docker-compose.production.yml restart
```

### View Container Stats
```bash
ssh deploy@your-server-ip "docker stats --no-stream"
```

### Clean Docker Resources
```bash
ssh deploy@your-server-ip "docker system prune -a -f"
```

---

## 🔍 Debugging

### Check Health Endpoints
```bash
# Public endpoint
curl http://your-server-ip/health

# API container
curl http://your-server-ip:8080/health

# Socket container
curl http://your-server-ip:8081/health
```

### View Recent Logs (Last 100 lines)
```bash
ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml logs --tail=100 api"
```

### Check Container Status
```bash
ssh deploy@your-server-ip "docker ps -a | grep circle"
```

### Inspect Container
```bash
ssh deploy@your-server-ip "docker inspect circle-api"
```

### Check Environment Variables
```bash
ssh deploy@your-server-ip "docker exec circle-api env | grep -v PASSWORD | grep -v SECRET | grep -v KEY"
```

---

## 🔄 Rollback

### Quick Rollback to Previous Version
```bash
ssh deploy@your-server-ip << 'EOF'
cd /opt/circle/Backend
export TAG=previous
docker-compose -f docker-compose.production.yml pull
docker-compose -f docker-compose.production.yml up -d
docker-compose -f docker-compose.production.yml ps
EOF
```

### Rollback to Specific Build
```bash
# Replace 123-abc1234 with actual build tag
ssh deploy@your-server-ip << 'EOF'
cd /opt/circle/Backend
export TAG=123-abc1234
docker-compose -f docker-compose.production.yml pull
docker-compose -f docker-compose.production.yml up -d
docker-compose -f docker-compose.production.yml ps
EOF
```

---

## 🛠️ Troubleshooting

### Jenkins Won't Start
```bash
# Check status
sudo systemctl status jenkins

# View logs
sudo journalctl -u jenkins -n 100 --no-pager

# Restart
sudo systemctl restart jenkins
```

### Build Stuck/Hanging
```bash
# Via Jenkins UI
Jenkins → Manage Jenkins → Manage Nodes and Clouds → Built-In Node → Disconnect

# Then reconnect
Built-In Node → Launch agent
```

### Out of Memory
```bash
# Check memory usage
ssh deploy@your-server-ip "free -h"

# Check container memory
ssh deploy@your-server-ip "docker stats --no-stream"

# Restart heavy containers
ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml restart api socket"
```

### Out of Disk Space
```bash
# Check disk usage
ssh deploy@your-server-ip "df -h"

# Clean Docker
ssh deploy@your-server-ip "docker system prune -a --volumes -f"

# Remove old images (older than 48 hours)
ssh deploy@your-server-ip "docker image prune -a --filter 'until=48h' -f"
```

### Container Won't Start
```bash
# View logs
ssh deploy@your-server-ip "docker logs circle-api --tail=100"

# Check for port conflicts
ssh deploy@your-server-ip "netstat -tulpn | grep -E '(8080|8081|6379)'"

# Remove and recreate
ssh deploy@your-server-ip << 'EOF'
cd /opt/circle/Backend
docker-compose -f docker-compose.production.yml down
docker-compose -f docker-compose.production.yml up -d
EOF
```

---

## 📊 Monitoring

### Check All Services Health
```bash
#!/bin/bash
SERVICES=("api" "socket" "redis" "matchmaking" "cron" "nginx")
for service in "${SERVICES[@]}"; do
    echo "Checking $service..."
    ssh deploy@your-server-ip "docker inspect circle-$service --format='{{.State.Status}}'"
done
```

### View Resource Usage
```bash
ssh deploy@your-server-ip << 'EOF'
echo "=== CPU & Memory ==="
free -h
echo ""
echo "=== Disk Usage ==="
df -h
echo ""
echo "=== Container Stats ==="
docker stats --no-stream
EOF
```

### Check Recent Deployments
```bash
ssh deploy@your-server-ip "cat /tmp/circle_last_deployment.txt"
```

---

## 🔐 Security

### Update System Packages
```bash
ssh root@your-server-ip << 'EOF'
apt-get update
apt-get upgrade -y
systemctl restart docker
systemctl restart jenkins
EOF
```

### Rotate Docker Hub Token
1. Generate new token in Docker Hub
2. Update in Jenkins: Manage Jenkins → Manage Credentials → docker-hub-creds
3. Test with a build

### Check Failed Login Attempts
```bash
ssh root@your-server-ip "grep 'Failed password' /var/log/auth.log | tail -20"
```

---

## 📝 Useful Aliases

Add these to your `~/.bashrc` or `~/.zshrc`:

```bash
# Circle deployment aliases
alias circle-ssh='ssh deploy@your-server-ip'
alias circle-logs='ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml logs -f"'
alias circle-status='ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml ps"'
alias circle-restart='ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml restart"'
alias circle-health='curl -s http://your-server-ip/health | jq'
```

---

## 🚨 Emergency Procedures

### Complete System Restart
```bash
ssh root@your-server-ip << 'EOF'
cd /opt/circle/Backend
docker-compose -f docker-compose.production.yml down
systemctl restart docker
sleep 5
docker-compose -f docker-compose.production.yml up -d
sleep 30
docker-compose -f docker-compose.production.yml ps
EOF
```

### Restore from Backup (if configured)
```bash
# Stop services
ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml down"

# Restore volumes (example)
# ssh deploy@your-server-ip "docker run --rm -v circle_redis_data:/data -v /backup:/backup alpine sh -c 'cd /data && tar xzf /backup/redis_data.tar.gz'"

# Start services
ssh deploy@your-server-ip "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml up -d"
```

---

## 📞 Support Contacts

- **Jenkins Issues**: Check `/var/log/jenkins/jenkins.log`
- **Docker Issues**: Check `docker logs <container-name>`
- **Application Issues**: Check application logs in containers

---

## 📚 Quick Links

- Jenkins: `http://your-server-ip:8080`
- API Health: `http://your-server-ip/health`
- Redis Commander (debug): `http://your-server-ip:8082` (if enabled)

---

## ✅ Pre-Deployment Checklist

Before each deployment:
- [ ] Code reviewed and merged
- [ ] Tests passing locally
- [ ] Environment variables updated (if needed)
- [ ] Database migrations ready (if needed)
- [ ] Backup taken (if critical changes)
- [ ] Team notified
- [ ] Monitoring ready

---

## 🎯 Performance Tips

1. **Build faster**: Use `FORCE_REBUILD=false` (default)
2. **Skip tests in emergency**: Use `SKIP_TESTS=true` parameter
3. **Monitor during deployment**: Keep logs open
4. **Schedule deployments**: Deploy during low-traffic hours
5. **Test in staging first**: Use `DEPLOY_ENV=staging` parameter

---

## 📈 Metrics to Monitor

- Build success rate
- Deployment duration
- Container restart count
- Memory usage trends
- Disk usage trends
- API response times
- Error rates

---

**Last Updated**: December 2024
**Version**: 1.0
