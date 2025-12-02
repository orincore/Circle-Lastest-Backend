# Circle Backend - Jenkins CI/CD Setup Guide

Complete guide to set up Jenkins for automated, error-free container deployments.

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Server Setup](#server-setup)
3. [Jenkins Configuration](#jenkins-configuration)
4. [Pipeline Setup](#pipeline-setup)
5. [Deployment Process](#deployment-process)
6. [Troubleshooting](#troubleshooting)
7. [Rollback Procedures](#rollback-procedures)

---

## 🎯 Prerequisites

### Server Requirements
- **OS**: Ubuntu 20.04 LTS or later
- **RAM**: Minimum 8GB (recommended for production)
- **CPU**: 2 vCPUs minimum
- **Disk**: 50GB+ SSD
- **Network**: Public IP with ports 80, 443, 8080 open

### Required Accounts
- Docker Hub account (for image registry)
- GitHub/GitLab account (for source code)
- Server with SSH access

---

## 🚀 Server Setup

### Step 1: Initial Server Setup

SSH into your server:
```bash
ssh root@your-server-ip
```

### Step 2: Run Automated Setup Script

```bash
# Clone your repository
git clone https://github.com/your-repo/circle-backend.git /opt/circle
cd /opt/circle/Backend

# Make setup script executable
chmod +x scripts/jenkins-server-setup.sh

# Run setup (as root)
sudo ./scripts/jenkins-server-setup.sh
```

This script will:
- ✅ Update system packages
- ✅ Install Docker & Docker Compose
- ✅ Install Java 17
- ✅ Install Jenkins
- ✅ Create deploy user
- ✅ Configure firewall
- ✅ Setup SSH keys
- ✅ Optimize Docker for production

**Expected time**: 10-15 minutes

### Step 3: Access Jenkins

1. Get your server's public IP:
```bash
curl ifconfig.me
```

2. Access Jenkins at: `http://YOUR_SERVER_IP:8080`

3. Get initial admin password:
```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

---

## ⚙️ Jenkins Configuration

### Step 1: Initial Setup Wizard

1. **Unlock Jenkins**: Paste the initial admin password
2. **Install Plugins**: Select "Install suggested plugins"
3. **Create Admin User**: Set up your admin credentials
4. **Jenkins URL**: Set to `http://YOUR_SERVER_IP:8080`

### Step 2: Install Required Plugins

Go to **Manage Jenkins** → **Manage Plugins** → **Available**

Install these plugins:
- ✅ **Docker Pipeline** - For Docker operations
- ✅ **SSH Agent Plugin** - For SSH deployments
- ✅ **Git Plugin** - For Git integration
- ✅ **AnsiColor Plugin** - For colored console output
- ✅ **Timestamper** - For build timestamps
- ✅ **Credentials Binding Plugin** - For secure credentials

Click **Install without restart**

### Step 3: Configure Credentials

Go to **Manage Jenkins** → **Manage Credentials** → **Global** → **Add Credentials**

#### 3.1 Docker Hub Credentials
- **Kind**: Username with password
- **Username**: Your Docker Hub username
- **Password**: Your Docker Hub password or access token
- **ID**: `docker-hub-creds`
- **Description**: Docker Hub Credentials

#### 3.2 SSH Key for Deployment
- **Kind**: SSH Username with private key
- **Username**: `deploy`
- **Private Key**: Enter directly (from `/home/deploy/.ssh/id_rsa`)
- **ID**: `deploy-ssh-key`
- **Description**: Deploy SSH Key

To get the private key:
```bash
sudo cat /home/deploy/.ssh/id_rsa
```

#### 3.3 Docker Registry Name
- **Kind**: Secret text
- **Secret**: Your Docker Hub username (e.g., `yourdockeruser`)
- **ID**: `docker-registry-name`
- **Description**: Docker Registry Username

#### 3.4 Deploy Server Host
- **Kind**: Secret text
- **Secret**: Your server IP or domain (e.g., `123.45.67.89`)
- **ID**: `deploy-server-host`
- **Description**: Production Server Host

#### 3.5 Deploy Server User
- **Kind**: Secret text
- **Secret**: `deploy`
- **ID**: `deploy-server-user`
- **Description**: Deploy User

### Step 4: Configure Global Tools

Go to **Manage Jenkins** → **Global Tool Configuration**

#### Git
- **Name**: Default
- **Path to Git executable**: `git`

#### Docker
- **Name**: docker
- **Installation root**: `/usr/bin/docker`

---

## 🔧 Pipeline Setup

### Step 1: Create Pipeline Job

1. Go to Jenkins Dashboard
2. Click **New Item**
3. Enter name: `Circle-Backend-Deploy`
4. Select **Pipeline**
5. Click **OK**

### Step 2: Configure Pipeline

#### General Settings
- ✅ **Discard old builds**: Keep last 20 builds
- ✅ **This project is parameterized**: Add parameters
  - Boolean: `SKIP_TESTS` (default: false)
  - Boolean: `FORCE_REBUILD` (default: false)
  - Choice: `DEPLOY_ENV` (choices: production, staging)

#### Build Triggers
- ✅ **GitHub hook trigger for GITScm polling** (if using GitHub webhooks)
- ✅ **Poll SCM**: `H/5 * * * *` (check every 5 minutes as fallback)

#### Pipeline Definition
- **Definition**: Pipeline script from SCM
- **SCM**: Git
- **Repository URL**: Your repository URL
- **Credentials**: Add your Git credentials if private
- **Branch**: `*/main` or `*/master`
- **Script Path**: `Backend/Jenkinsfile`

### Step 3: Setup Git Webhook (Optional but Recommended)

#### For GitHub:
1. Go to your repository → **Settings** → **Webhooks**
2. Click **Add webhook**
3. **Payload URL**: `http://YOUR_SERVER_IP:8080/github-webhook/`
4. **Content type**: `application/json`
5. **Events**: Just the push event
6. Click **Add webhook**

#### For GitLab:
1. Go to your repository → **Settings** → **Webhooks**
2. **URL**: `http://YOUR_SERVER_IP:8080/project/Circle-Backend-Deploy`
3. **Trigger**: Push events
4. Click **Add webhook**

---

## 🚀 Deployment Process

### First Deployment

1. **Prepare Environment File** on server:
```bash
ssh deploy@your-server-ip
cd /opt/circle/Backend
cp .env.production.example .env.production
nano .env.production  # Fill in your values
```

2. **Trigger First Build**:
   - Go to Jenkins → Circle-Backend-Deploy
   - Click **Build with Parameters**
   - Leave defaults, click **Build**

3. **Monitor Build**:
   - Click on build number (e.g., #1)
   - Click **Console Output**
   - Watch the deployment process

### Build Stages

The pipeline executes these stages:

1. **Checkout** - Pulls latest code from Git
2. **Install & Test** - Installs dependencies, runs linting
3. **Build Docker Images** - Builds all 4 service images in parallel
4. **Push Images** - Pushes to Docker Hub with version tags
5. **Deploy** - Zero-downtime rolling deployment
6. **Verify Deployment** - Health checks and verification
7. **Rollback** (if failure) - Automatic rollback to previous version

### Subsequent Deployments

Just push to your repository:
```bash
git add .
git commit -m "Your changes"
git push origin main
```

Jenkins will automatically:
- ✅ Detect the push (via webhook or polling)
- ✅ Build new images
- ✅ Run tests
- ✅ Deploy with zero downtime
- ✅ Verify deployment
- ✅ Rollback if issues detected

---

## 🔍 Monitoring Deployments

### View Build Status
```bash
# From Jenkins UI
Dashboard → Circle-Backend-Deploy → Build History
```

### Check Container Status
```bash
ssh deploy@your-server-ip
cd /opt/circle/Backend
docker-compose -f docker-compose.production.yml ps
```

### View Logs
```bash
# All services
docker-compose -f docker-compose.production.yml logs -f

# Specific service
docker-compose -f docker-compose.production.yml logs -f api

# Last 100 lines
docker-compose -f docker-compose.production.yml logs --tail=100 api
```

### Health Checks
```bash
# Public endpoint
curl http://your-server-ip/health

# Direct container check
docker-compose -f docker-compose.production.yml exec api curl http://localhost:8080/health
```

### Resource Usage
```bash
# Real-time stats
docker stats

# System resources
htop
```

---

## 🛠️ Troubleshooting

### Build Fails at "Install & Test"

**Symptom**: npm install or lint errors

**Solution**:
```bash
# Check package.json syntax
# Verify all dependencies are available
# Check Node.js version compatibility
```

### Build Fails at "Build Docker Images"

**Symptom**: Docker build errors

**Solution**:
```bash
# Check Dockerfile syntax
# Verify base images are accessible
# Check disk space: df -h
# Clear Docker cache: docker system prune -a
```

### Build Fails at "Push Images"

**Symptom**: Authentication or network errors

**Solution**:
1. Verify Docker Hub credentials in Jenkins
2. Check network connectivity
3. Verify Docker Hub repository exists

### Deployment Fails - Health Check Timeout

**Symptom**: Service doesn't respond to health checks

**Solution**:
```bash
# SSH into server
ssh deploy@your-server-ip
cd /opt/circle/Backend

# Check container logs
docker-compose -f docker-compose.production.yml logs api

# Check container status
docker-compose -f docker-compose.production.yml ps

# Restart specific service
docker-compose -f docker-compose.production.yml restart api
```

### Containers Keep Restarting

**Symptom**: Containers in restart loop

**Solution**:
```bash
# Check logs for errors
docker-compose -f docker-compose.production.yml logs --tail=100 api

# Common issues:
# - Missing environment variables
# - Database connection issues
# - Port conflicts
# - Memory limits exceeded

# Check .env.production file
cat .env.production
```

### Out of Disk Space

**Symptom**: "No space left on device"

**Solution**:
```bash
# Check disk usage
df -h

# Clean Docker resources
docker system prune -a --volumes

# Remove old images
docker image prune -a --filter "until=48h"

# Check large files
du -sh /var/lib/docker/*
```

---

## 🔄 Rollback Procedures

### Automatic Rollback

If deployment verification fails, Jenkins automatically rolls back to the previous version.

### Manual Rollback

#### Option 1: Via Jenkins
1. Go to previous successful build
2. Click **Replay**
3. Click **Run**

#### Option 2: Via Server

```bash
ssh deploy@your-server-ip
cd /opt/circle/Backend

# Pull previous images
export TAG=previous
docker-compose -f docker-compose.production.yml pull

# Restart services
docker-compose -f docker-compose.production.yml up -d

# Verify
docker-compose -f docker-compose.production.yml ps
curl http://localhost/health
```

#### Option 3: Specific Version

```bash
# Find available tags
docker images | grep circle

# Use specific tag
export TAG=123-abc1234  # Build number and commit hash
docker-compose -f docker-compose.production.yml pull
docker-compose -f docker-compose.production.yml up -d
```

---

## 🔒 Security Best Practices

### 1. Secure Jenkins
```bash
# Enable HTTPS for Jenkins
# Install SSL certificate
# Configure reverse proxy (nginx)
```

### 2. Restrict Access
```bash
# Configure firewall to allow only specific IPs
sudo ufw allow from YOUR_IP to any port 8080

# Enable Jenkins security realm
# Use role-based access control
```

### 3. Secure Credentials
- ✅ Never commit credentials to Git
- ✅ Use Jenkins credentials store
- ✅ Rotate secrets regularly
- ✅ Use strong passwords

### 4. Regular Updates
```bash
# Update Jenkins
# Update plugins
# Update system packages
sudo apt-get update && sudo apt-get upgrade
```

---

## 📊 Performance Optimization

### Build Performance

1. **Enable Docker BuildKit**:
```bash
export DOCKER_BUILDKIT=1
```

2. **Use Build Cache**:
- Pipeline already configured with `--cache-from`

3. **Parallel Builds**:
- All 4 images build in parallel

### Deployment Performance

1. **Pre-pull Images**:
```bash
# Images are pulled before deployment
docker-compose pull
```

2. **Health Check Optimization**:
- Configured with 30 retries, 5-second intervals
- Adjust in Jenkinsfile if needed

---

## 📈 Monitoring & Alerts

### Setup Slack Notifications (Optional)

1. Install **Slack Notification Plugin** in Jenkins
2. Configure Slack workspace in Jenkins
3. Uncomment Slack notification blocks in Jenkinsfile
4. Set `ENABLE_SLACK=true` in environment variables

### Email Notifications

1. Configure SMTP in **Manage Jenkins** → **Configure System**
2. Add email notification to post-build actions

---

## 🆘 Support & Resources

### Useful Commands

```bash
# Restart Jenkins
sudo systemctl restart jenkins

# View Jenkins logs
sudo journalctl -u jenkins -f

# Restart Docker
sudo systemctl restart docker

# Check Jenkins status
sudo systemctl status jenkins

# View deployment history
cat /tmp/circle_last_deployment.txt
```

### Log Locations

- Jenkins logs: `/var/log/jenkins/jenkins.log`
- Docker logs: `/var/lib/docker/containers/`
- Application logs: `/opt/circle/logs/`
- Nginx logs: `/var/log/nginx/`

### Documentation Links

- [Jenkins Documentation](https://www.jenkins.io/doc/)
- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)

---

## ✅ Deployment Checklist

Before going live:

- [ ] Server setup completed
- [ ] Jenkins installed and configured
- [ ] All credentials added
- [ ] Pipeline job created
- [ ] Webhook configured
- [ ] Environment variables set
- [ ] First deployment successful
- [ ] Health checks passing
- [ ] Rollback tested
- [ ] Monitoring configured
- [ ] Firewall configured
- [ ] SSL certificates installed
- [ ] Backups configured
- [ ] Team trained on procedures

---

## 🎉 Conclusion

Your Jenkins CI/CD pipeline is now ready for smooth, automated deployments!

**Key Features**:
- ✅ Zero-downtime deployments
- ✅ Automatic rollback on failure
- ✅ Parallel image building
- ✅ Health check verification
- ✅ Container resource optimization
- ✅ Comprehensive error handling

**Next Steps**:
1. Test the pipeline with a small change
2. Monitor the first few deployments
3. Setup monitoring and alerts
4. Document any custom configurations
5. Train your team on the deployment process

For issues or questions, refer to the troubleshooting section or check the logs.

Happy deploying! 🚀
