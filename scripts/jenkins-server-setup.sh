#!/bin/bash
# ============================================
# Circle Backend - Jenkins Server Setup
# Run this on your production server
# ============================================

set -e

echo "🚀 Circle Backend - Jenkins Server Setup"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "❌ Please run as root (use sudo)"
    exit 1
fi

# ============================================
# 1. Update System
# ============================================
echo ""
echo "📦 Step 1: Updating system packages..."
apt-get update
apt-get upgrade -y

# ============================================
# 2. Install Docker
# ============================================
echo ""
echo "🐳 Step 2: Installing Docker..."
if ! command -v docker &> /dev/null; then
    # Remove old versions
    apt-get remove -y docker docker-engine docker.io containerd runc || true
    
    # Install dependencies
    apt-get install -y \
        ca-certificates \
        curl \
        gnupg \
        lsb-release
    
    # Add Docker's official GPG key
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    
    # Set up repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    # Install Docker Engine
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    
    # Start and enable Docker
    systemctl start docker
    systemctl enable docker
    
    echo "✅ Docker installed successfully"
else
    echo "✅ Docker already installed"
fi

# ============================================
# 3. Install Docker Compose (standalone)
# ============================================
echo ""
echo "🔧 Step 3: Installing Docker Compose..."
if ! command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE_VERSION="v2.24.0"
    curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "✅ Docker Compose installed successfully"
else
    echo "✅ Docker Compose already installed"
fi

# ============================================
# 4. Install Java (for Jenkins)
# ============================================
echo ""
echo "☕ Step 4: Installing Java..."
if ! command -v java &> /dev/null; then
    apt-get install -y openjdk-17-jdk
    echo "✅ Java installed successfully"
else
    echo "✅ Java already installed"
fi

# ============================================
# 5. Install Jenkins
# ============================================
echo ""
echo "🔨 Step 5: Installing Jenkins..."
if ! command -v jenkins &> /dev/null; then
    # Add Jenkins repository
    curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key | tee \
        /usr/share/keyrings/jenkins-keyring.asc > /dev/null
    
    echo deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] \
        https://pkg.jenkins.io/debian-stable binary/ | tee \
        /etc/apt/sources.list.d/jenkins.list > /dev/null
    
    apt-get update
    apt-get install -y jenkins
    
    # Start and enable Jenkins
    systemctl start jenkins
    systemctl enable jenkins
    
    echo "✅ Jenkins installed successfully"
    echo "⏳ Waiting for Jenkins to start (30 seconds)..."
    sleep 30
else
    echo "✅ Jenkins already installed"
fi

# ============================================
# 6. Configure Jenkins User
# ============================================
echo ""
echo "👤 Step 6: Configuring Jenkins user..."

# Add jenkins user to docker group
usermod -aG docker jenkins

# Create deploy user for SSH deployments
if ! id "deploy" &>/dev/null; then
    useradd -m -s /bin/bash deploy
    usermod -aG docker deploy
    echo "✅ Deploy user created"
else
    echo "✅ Deploy user already exists"
fi

# ============================================
# 7. Setup Application Directory
# ============================================
echo ""
echo "📁 Step 7: Setting up application directory..."
mkdir -p /opt/circle/Backend
chown -R deploy:deploy /opt/circle

# ============================================
# 8. Configure Firewall
# ============================================
echo ""
echo "🔒 Step 8: Configuring firewall..."
if command -v ufw &> /dev/null; then
    ufw allow 22/tcp      # SSH
    ufw allow 80/tcp      # HTTP
    ufw allow 443/tcp     # HTTPS
    ufw allow 8080/tcp    # Jenkins
    ufw --force enable
    echo "✅ Firewall configured"
else
    echo "⚠️  UFW not installed, skipping firewall configuration"
fi

# ============================================
# 9. Install Additional Tools
# ============================================
echo ""
echo "🛠️  Step 9: Installing additional tools..."
apt-get install -y \
    git \
    curl \
    wget \
    htop \
    net-tools \
    vim \
    jq

# ============================================
# 10. Setup SSH Keys for Deploy User
# ============================================
echo ""
echo "🔑 Step 10: Setting up SSH keys..."
if [ ! -f /home/deploy/.ssh/id_rsa ]; then
    sudo -u deploy ssh-keygen -t rsa -b 4096 -f /home/deploy/.ssh/id_rsa -N ""
    echo "✅ SSH keys generated for deploy user"
    echo ""
    echo "📋 Public key (add this to Jenkins credentials):"
    cat /home/deploy/.ssh/id_rsa.pub
else
    echo "✅ SSH keys already exist"
fi

# ============================================
# 11. Optimize Docker for Production
# ============================================
echo ""
echo "⚙️  Step 11: Optimizing Docker..."
cat > /etc/docker/daemon.json <<EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "storage-driver": "overlay2",
  "userland-proxy": false,
  "live-restore": true
}
EOF

systemctl restart docker
echo "✅ Docker optimized"

# ============================================
# 12. Setup Log Rotation
# ============================================
echo ""
echo "📝 Step 12: Setting up log rotation..."
cat > /etc/logrotate.d/circle <<EOF
/opt/circle/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    notifempty
    create 0640 deploy deploy
    sharedscripts
}
EOF
echo "✅ Log rotation configured"

# ============================================
# Final Steps
# ============================================
echo ""
echo "=========================================="
echo "✅ Jenkins Server Setup Complete!"
echo "=========================================="
echo ""
echo "📋 Next Steps:"
echo ""
echo "1. Access Jenkins at: http://$(curl -s ifconfig.me):8080"
echo ""
echo "2. Get initial admin password:"
echo "   sudo cat /var/lib/jenkins/secrets/initialAdminPassword"
echo ""
echo "3. Install required Jenkins plugins:"
echo "   - Docker Pipeline"
echo "   - SSH Agent"
echo "   - Git"
echo "   - AnsiColor"
echo "   - Timestamper"
echo ""
echo "4. Configure Jenkins credentials:"
echo "   - Docker Hub credentials (ID: docker-hub-creds)"
echo "   - SSH key for deployment (ID: deploy-ssh-key)"
echo "   - Server host (ID: deploy-server-host)"
echo "   - Server user (ID: deploy-server-user)"
echo "   - Docker registry name (ID: docker-registry-name)"
echo ""
echo "5. Create a new Pipeline job and point to your Jenkinsfile"
echo ""
echo "6. Setup webhook in your Git repository for automatic builds"
echo ""
echo "=========================================="
echo "🔐 Security Reminders:"
echo "   - Change default passwords"
echo "   - Enable HTTPS for Jenkins"
echo "   - Restrict Jenkins access by IP"
echo "   - Regular security updates"
echo "=========================================="
