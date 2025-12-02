#!/bin/bash
# ============================================
# Circle Backend - Manual Rollback Script
# Usage: ./rollback.sh [commit_hash]
# ============================================

set -o pipefail

DEPLOY_DIR="/root/Circle-Lastest-Backend"
COMPOSE_FILE="docker-compose.production.yml"
BACKUP_DIR="/root/circle-backups"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

cd "$DEPLOY_DIR" || { log_error "Directory not found: $DEPLOY_DIR"; exit 1; }

echo "============================================"
echo "🔄 Circle Backend - Manual Rollback"
echo "============================================"
echo ""

# Get target commit
TARGET_COMMIT="$1"

if [ -z "$TARGET_COMMIT" ]; then
    # Show recent commits
    log_info "Recent commits:"
    echo ""
    git log --oneline -10
    echo ""
    
    # Check if we have a saved previous commit
    if [ -f "$BACKUP_DIR/last-deployment.txt" ]; then
        log_info "Last deployment info:"
        cat "$BACKUP_DIR/last-deployment.txt"
        echo ""
    fi
    
    read -p "Enter commit hash to rollback to (or 'HEAD~1' for previous): " TARGET_COMMIT
fi

if [ -z "$TARGET_COMMIT" ]; then
    log_error "No commit specified. Exiting."
    exit 1
fi

CURRENT_COMMIT=$(git rev-parse HEAD)
log_info "Current commit: $CURRENT_COMMIT"
log_info "Rolling back to: $TARGET_COMMIT"
echo ""

read -p "Are you sure you want to rollback? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    log_warn "Rollback cancelled."
    exit 0
fi

echo ""
log_info "Starting rollback..."

# Checkout target commit
git fetch --all
git checkout "$TARGET_COMMIT" || { log_error "Failed to checkout $TARGET_COMMIT"; exit 1; }

# Install dependencies
log_info "Installing dependencies..."
npm ci --prefer-offline --no-audit 2>/dev/null || npm install

# Build
log_info "Building TypeScript..."
npm run build || { log_error "Build failed!"; exit 1; }

# Rebuild and restart containers
log_info "Rebuilding Docker containers..."
docker-compose -f "$COMPOSE_FILE" build --no-cache
docker-compose -f "$COMPOSE_FILE" up -d

# Wait and check health
log_info "Waiting for services..."
sleep 15

API_HEALTH=$(curl -sf http://localhost:8080/health || echo "failed")
SOCKET_HEALTH=$(curl -sf http://localhost:8081/health || echo "failed")

if [ "$API_HEALTH" = "failed" ] || [ "$SOCKET_HEALTH" = "failed" ]; then
    log_error "Health check failed after rollback!"
    log_error "Manual intervention required."
    docker-compose -f "$COMPOSE_FILE" ps
    docker-compose -f "$COMPOSE_FILE" logs --tail=50
    exit 1
fi

echo ""
echo "============================================"
log_success "🎉 Rollback completed successfully!"
echo "============================================"
echo ""
log_info "Container status:"
docker-compose -f "$COMPOSE_FILE" ps

# Save rollback info
cat > "$BACKUP_DIR/last-rollback.txt" << EOF
Rollback Time: $(date)
From Commit: $CURRENT_COMMIT
To Commit: $TARGET_COMMIT
EOF

echo ""
log_info "Rollback info saved to $BACKUP_DIR/last-rollback.txt"
