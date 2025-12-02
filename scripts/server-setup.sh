#!/bin/bash
# ============================================
# Circle Backend - Server Setup Script
# Initial setup for production server
# ============================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "Please run as root or with sudo"
    exit 1
fi

log_info "Starting Circle Backend server setup..."

# ============================================
# 1. System Updates
# ============================================
log_info "Updating system packages..."
apt-get update -y
apt-get upgrade -y

# ============================================
# 2. Install Docker
# ============================================
log_info "Installing Docker..."

if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    
    # Add current user to docker group
    usermod -aG docker $SUDO_USER 2>/dev/null || true
    
    # Enable Docker service
    systemctl enable docker
    systemctl start docker
    
    log_success "Docker installed successfully!"
else
    log_info "Docker already installed"
fi

# ============================================
# 3. Install Docker Compose
# ============================================
log_info "Installing Docker Compose..."

if ! command -v docker-compose &> /dev/null; then
    COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep 'tag_name' | cut -d\" -f4)
    curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    
    log_success "Docker Compose installed successfully!"
else
    log_info "Docker Compose already installed"
fi

# ============================================
# 4. System Optimizations
# ============================================
log_info "Applying system optimizations..."

# Increase file descriptor limits
cat >> /etc/security/limits.conf << 'EOF'
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
EOF

# Optimize sysctl for high connections
cat > /etc/sysctl.d/99-circle-optimizations.conf << 'EOF'
# Network optimizations
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15

# Memory optimizations
vm.swappiness = 10
vm.dirty_ratio = 60
vm.dirty_background_ratio = 2

# File system
fs.file-max = 2097152
fs.inotify.max_user_watches = 524288
EOF

sysctl -p /etc/sysctl.d/99-circle-optimizations.conf

log_success "System optimizations applied!"

# ============================================
# 5. Create Application Directory
# ============================================
log_info "Creating application directory..."

mkdir -p /opt/circle
mkdir -p /opt/circle/docker/ssl
mkdir -p /opt/circle/logs
mkdir -p /opt/circle/backups

# Set permissions
chown -R $SUDO_USER:$SUDO_USER /opt/circle 2>/dev/null || true

log_success "Application directory created at /opt/circle"

# ============================================
# 6. Setup Swap (for 8GB RAM systems)
# ============================================
log_info "Setting up swap space..."

if [ ! -f /swapfile ]; then
    # Create 2GB swap
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    
    # Make permanent
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    
    log_success "2GB swap created!"
else
    log_info "Swap already exists"
fi

# ============================================
# 7. Install Monitoring Tools
# ============================================
log_info "Installing monitoring tools..."

apt-get install -y htop iotop nethogs ncdu

log_success "Monitoring tools installed!"

# ============================================
# 8. Setup Firewall
# ============================================
log_info "Configuring firewall..."

apt-get install -y ufw

ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp

# Enable firewall (will prompt for confirmation)
log_warning "Enabling firewall - make sure SSH is allowed!"
ufw --force enable

log_success "Firewall configured!"

# ============================================
# 9. Setup Log Rotation
# ============================================
log_info "Configuring log rotation..."

cat > /etc/logrotate.d/circle << 'EOF'
/opt/circle/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 root root
    sharedscripts
    postrotate
        docker-compose -f /opt/circle/docker-compose.production.yml exec -T nginx nginx -s reopen 2>/dev/null || true
    endscript
}
EOF

log_success "Log rotation configured!"

# ============================================
# 10. Create Deploy User (optional)
# ============================================
log_info "Creating deploy user..."

if ! id "deploy" &>/dev/null; then
    useradd -m -s /bin/bash deploy
    usermod -aG docker deploy
    
    # Setup SSH directory
    mkdir -p /home/deploy/.ssh
    chmod 700 /home/deploy/.ssh
    touch /home/deploy/.ssh/authorized_keys
    chmod 600 /home/deploy/.ssh/authorized_keys
    chown -R deploy:deploy /home/deploy/.ssh
    
    # Give deploy user access to /opt/circle
    chown -R deploy:deploy /opt/circle
    
    log_success "Deploy user created!"
    log_warning "Add your SSH public key to /home/deploy/.ssh/authorized_keys"
else
    log_info "Deploy user already exists"
fi

# ============================================
# Summary
# ============================================
echo ""
echo "============================================"
log_success "Server setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "1. Copy your application files to /opt/circle"
echo "2. Create .env.production from .env.example"
echo "3. Add SSL certificates to /opt/circle/docker/ssl (optional)"
echo "4. Run: cd /opt/circle && ./scripts/docker-deploy.sh deploy"
echo ""
echo "System info:"
echo "  - Docker: $(docker --version)"
echo "  - Docker Compose: $(docker-compose --version)"
echo "  - RAM: $(free -h | awk '/^Mem:/ {print $2}')"
echo "  - CPU: $(nproc) cores"
echo "  - Swap: $(free -h | awk '/^Swap:/ {print $2}')"
echo ""
log_warning "Please reboot the server to apply all changes!"
