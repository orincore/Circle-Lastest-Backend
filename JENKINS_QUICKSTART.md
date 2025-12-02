# Jenkins CI/CD - Quick Start Guide

Get your Jenkins pipeline running in under 1 hour!

## 🚀 Step-by-Step Setup

### Step 1: Prepare Your Server (5 minutes)

```bash
# SSH into your server
ssh root@YOUR_SERVER_IP

# Clone repository
git clone https://github.com/YOUR_USERNAME/circle-backend.git /opt/circle
cd /opt/circle/Backend
```

### Step 2: Run Automated Setup (15 minutes)

```bash
# Make script executable
chmod +x scripts/jenkins-server-setup.sh

# Run setup (installs Docker, Jenkins, etc.)
sudo ./scripts/jenkins-server-setup.sh
```

**What this installs**:
- Docker & Docker Compose
- Java 17
- Jenkins
- Creates deploy user
- Configures firewall
- Sets up SSH keys

### Step 3: Access Jenkins (2 minutes)

1. Open browser: `http://YOUR_SERVER_IP:8080`

2. Get initial password:
```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

3. Paste password and click **Continue**

### Step 4: Jenkins Initial Setup (10 minutes)

1. **Install Plugins**: Click "Install suggested plugins"
   - Wait for installation to complete

2. **Create Admin User**:
   - Username: `admin`
   - Password: (choose a strong password)
   - Full name: Your name
   - Email: your@email.com

3. **Jenkins URL**: Keep default (`http://YOUR_SERVER_IP:8080`)

4. Click **Start using Jenkins**

### Step 5: Install Additional Plugins (5 minutes)

1. Go to **Manage Jenkins** → **Manage Plugins** → **Available**

2. Search and install:
   - [x] Docker Pipeline
   - [x] SSH Agent Plugin
   - [x] AnsiColor Plugin
   - [x] Timestamper

3. Click **Install without restart**

### Step 6: Configure Credentials (10 minutes)

Go to **Manage Jenkins** → **Manage Credentials** → **Global** → **Add Credentials**

#### 6.1 Docker Hub Credentials
```
Kind: Username with password
Username: YOUR_DOCKER_HUB_USERNAME
Password: YOUR_DOCKER_HUB_PASSWORD
ID: docker-hub-creds
Description: Docker Hub Credentials
```

#### 6.2 SSH Key for Deployment
```bash
# First, get the private key from server
ssh root@YOUR_SERVER_IP "cat /home/deploy/.ssh/id_rsa"
```

Then in Jenkins:
```
Kind: SSH Username with private key
Username: deploy
Private Key: [Paste the key from above]
ID: deploy-ssh-key
Description: Deploy SSH Key
```

#### 6.3 Docker Registry Name
```
Kind: Secret text
Secret: YOUR_DOCKER_HUB_USERNAME
ID: docker-registry-name
Description: Docker Registry Username
```

#### 6.4 Deploy Server Host
```
Kind: Secret text
Secret: YOUR_SERVER_IP
ID: deploy-server-host
Description: Production Server Host
```

#### 6.5 Deploy Server User
```
Kind: Secret text
Secret: deploy
ID: deploy-server-user
Description: Deploy User
```

### Step 7: Create Pipeline Job (5 minutes)

1. Click **New Item**
2. Name: `Circle-Backend-Deploy`
3. Type: **Pipeline**
4. Click **OK**

5. Configure:
   - **General** → Check "Discard old builds" → Keep last 20 builds
   
   - **Pipeline**:
     - Definition: `Pipeline script from SCM`
     - SCM: `Git`
     - Repository URL: `YOUR_GIT_REPO_URL`
     - Branch: `*/main` (or `*/master`)
     - Script Path: `Backend/Jenkinsfile`

6. Click **Save**

### Step 8: Prepare Environment File (5 minutes)

```bash
# SSH to server
ssh deploy@YOUR_SERVER_IP

# Navigate to project
cd /opt/circle/Backend

# Copy example environment file
cp .env.production.example .env.production

# Edit with your values
nano .env.production
```

**Required values**:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- Other service credentials

Save and exit (`Ctrl+X`, then `Y`, then `Enter`)

### Step 9: First Deployment (5 minutes)

1. In Jenkins, go to **Circle-Backend-Deploy**
2. Click **Build Now**
3. Click on build number (e.g., `#1`)
4. Click **Console Output**
5. Watch the deployment process

**Expected stages**:
1. ✅ Checkout
2. ✅ Install & Test
3. ✅ Build Docker Images
4. ✅ Push Images
5. ✅ Deploy
6. ✅ Verify Deployment

### Step 10: Verify Deployment (2 minutes)

```bash
# Check health endpoint
curl http://YOUR_SERVER_IP/health

# Should return: {"status":"ok"}
```

```bash
# Check all containers
ssh deploy@YOUR_SERVER_IP "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml ps"

# All should show "Up" status
```

## ✅ You're Done!

Your Jenkins CI/CD pipeline is now active! 🎉

## 🔄 How to Deploy Changes

From now on, just push to your repository:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

Jenkins will automatically:
1. Detect the push
2. Build new images
3. Deploy with zero downtime
4. Verify deployment
5. Rollback if any issues

## 🎯 Optional: Setup Webhook (Recommended)

### For GitHub:

1. Go to your repository → **Settings** → **Webhooks**
2. Click **Add webhook**
3. Payload URL: `http://YOUR_SERVER_IP:8080/github-webhook/`
4. Content type: `application/json`
5. Events: Just the push event
6. Click **Add webhook**

### For GitLab:

1. Go to your repository → **Settings** → **Webhooks**
2. URL: `http://YOUR_SERVER_IP:8080/project/Circle-Backend-Deploy`
3. Trigger: Push events
4. Click **Add webhook**

## 📊 Monitor Your Deployments

### View Build History
```
Jenkins → Circle-Backend-Deploy → Build History
```

### View Container Logs
```bash
ssh deploy@YOUR_SERVER_IP "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml logs -f api"
```

### Check Container Status
```bash
ssh deploy@YOUR_SERVER_IP "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml ps"
```

### View Resource Usage
```bash
ssh deploy@YOUR_SERVER_IP "docker stats --no-stream"
```

## 🔧 Common Commands

### Restart Jenkins
```bash
ssh root@YOUR_SERVER_IP "systemctl restart jenkins"
```

### Restart Specific Service
```bash
ssh deploy@YOUR_SERVER_IP "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml restart api"
```

### Manual Rollback
```bash
ssh deploy@YOUR_SERVER_IP << 'EOF'
cd /opt/circle/Backend
export TAG=previous
docker-compose -f docker-compose.production.yml pull
docker-compose -f docker-compose.production.yml up -d
EOF
```

### Clean Docker Resources
```bash
ssh deploy@YOUR_SERVER_IP "docker system prune -a -f"
```

## 🆘 Troubleshooting

### Build Fails
1. Check console output in Jenkins
2. Look for red error messages
3. Common issues:
   - Missing credentials
   - Network issues
   - Syntax errors in code

### Deployment Fails
1. SSH to server and check logs:
```bash
ssh deploy@YOUR_SERVER_IP "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml logs --tail=100"
```

2. Check environment variables:
```bash
ssh deploy@YOUR_SERVER_IP "cat /opt/circle/Backend/.env.production"
```

3. Restart services:
```bash
ssh deploy@YOUR_SERVER_IP "cd /opt/circle/Backend && docker-compose -f docker-compose.production.yml restart"
```

### Health Check Fails
1. Check if services are running:
```bash
ssh deploy@YOUR_SERVER_IP "docker ps"
```

2. Check specific service logs:
```bash
ssh deploy@YOUR_SERVER_IP "docker logs circle-api --tail=50"
```

3. Test health endpoint directly:
```bash
curl http://YOUR_SERVER_IP/health
```

## 📚 Full Documentation

For detailed information, see:
- **JENKINS_SETUP.md** - Complete setup guide
- **JENKINS_QUICK_REFERENCE.md** - Quick commands
- **JENKINS_DEPLOYMENT_SUMMARY.md** - Implementation details
- **DOCKER_DEPLOYMENT.md** - Docker deployment guide

## 🎉 Success Indicators

You know it's working when:
- ✅ Jenkins shows green checkmarks for builds
- ✅ Health endpoint returns `{"status":"ok"}`
- ✅ All containers show "Up" status
- ✅ No errors in container logs
- ✅ Automatic deployments work after git push

## 🚀 Next Steps

1. **Test the pipeline**: Make a small change and push
2. **Setup monitoring**: Configure alerts
3. **Enable HTTPS**: Install SSL certificates
4. **Create staging**: Setup staging environment
5. **Train team**: Share documentation with team

---

**Setup Time**: ~1 hour
**Difficulty**: Medium
**Status**: Production Ready

Need help? Check the full documentation or review the troubleshooting section!
