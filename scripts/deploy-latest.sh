#!/bin/bash
# ============================================
# Circle Backend - Zero-Downtime Deployment
# With automatic rollback on failure
# ============================================

set -o pipefail

# Configuration
DEPLOY_DIR="/root/Circle-Lastest-Backend"
COMPOSE_FILE="docker-compose.production.yml"
BRANCH="main"
HEALTH_CHECK_RETRIES=30
HEALTH_CHECK_INTERVAL=5
BACKUP_DIR="/root/circle-backups"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Store deployment state for rollback
PREVIOUS_COMMIT=""
DEPLOYMENT_STARTED=false
CONTAINERS_STOPPED=false

# Cleanup function for rollback
rollback() {
    log_error "Deployment failed! Initiating rollback..."
    
    cd "$DEPLOY_DIR" || exit 1
    
    if [ -n "$PREVIOUS_COMMIT" ]; then
        log_warn "Rolling back to previous commit: $PREVIOUS_COMMIT"
        git checkout "$PREVIOUS_COMMIT" 2>/dev/null || true
    fi
    
    if [ "$CONTAINERS_STOPPED" = true ]; then
        log_warn "Restarting containers with previous code..."
        docker-compose -f "$COMPOSE_FILE" up -d --build 2>/dev/null || true
        
        # Wait for containers to start
        sleep 10
        
        # Check if rollback was successful
        if check_health; then
            log_success "Rollback successful! Services restored."
        else
            log_error "Rollback failed! Manual intervention required."
            log_error "Try: docker-compose -f $COMPOSE_FILE up -d --build"
        fi
    fi
    
    exit 1
}

# Trap errors and call rollback
trap 'rollback' ERR

# Health check function
check_health() {
    local api_healthy=false
    local socket_healthy=false
    
    # Check API health
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        api_healthy=true
    fi
    
    # Check Socket health
    if curl -sf http://localhost:8081/health > /dev/null 2>&1; then
        socket_healthy=true
    fi
    
    if [ "$api_healthy" = true ] && [ "$socket_healthy" = true ]; then
        return 0
    fi
    return 1
}

# Wait for services to become healthy
wait_for_health() {
    log_info "Waiting for services to become healthy..."
    
    for i in $(seq 1 $HEALTH_CHECK_RETRIES); do
        if check_health; then
            log_success "All services are healthy!"
            return 0
        fi
        log_info "Health check attempt $i/$HEALTH_CHECK_RETRIES - waiting ${HEALTH_CHECK_INTERVAL}s..."
        sleep $HEALTH_CHECK_INTERVAL
    done
    
    log_error "Services failed to become healthy after $((HEALTH_CHECK_RETRIES * HEALTH_CHECK_INTERVAL)) seconds"
    return 1
}

# Main deployment
main() {
    echo "============================================"
    echo "🚀 Circle Backend - Zero-Downtime Deployment"
    echo "   Started at: $(date)"
    echo "============================================"
    echo ""
    
    cd "$DEPLOY_DIR" || { log_error "Deploy directory not found: $DEPLOY_DIR"; exit 1; }
    
    # Create backup directory
    mkdir -p "$BACKUP_DIR"
    
    # ============================================
    # Step 1: Save current state for rollback
    # ============================================
    log_info "Step 1: Saving current state for rollback..."
    PREVIOUS_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
    log_info "Current commit: $PREVIOUS_COMMIT"
    
    # ============================================
    # Step 2: Fetch and pull latest code
    # ============================================
    log_info "Step 2: Fetching latest code from git..."
    git fetch --all
    git checkout "$BRANCH"
    git reset --hard "origin/$BRANCH"
    
    NEW_COMMIT=$(git rev-parse HEAD)
    log_info "New commit: $NEW_COMMIT"
    
    if [ "$PREVIOUS_COMMIT" = "$NEW_COMMIT" ]; then
        log_warn "No new commits. Rebuilding anyway..."
    else
        log_success "New changes detected!"
        echo ""
        log_info "Changes since last deployment:"
        git log --oneline "$PREVIOUS_COMMIT..$NEW_COMMIT" 2>/dev/null || git log -5 --oneline
        echo ""
    fi
    
    DEPLOYMENT_STARTED=true
    
    # ============================================
    # Step 3: Build Docker images
    # ============================================
    # NOTE: Skip npm install and TypeScript build on host
    # Docker handles this inside containers with proper memory (2GB)
    # This avoids the "heap out of memory" error on low-RAM servers
    
    log_info "Step 3: Building Docker images..."
    log_info "(TypeScript will be compiled inside Docker with 2GB memory)"
    docker-compose -f "$COMPOSE_FILE" build --no-cache || {
        log_error "Docker build failed!"
        rollback
    }
    log_success "Docker images built!"
    
    # ============================================
    # Step 4: Rolling update - one service at a time
    # ============================================
    log_info "Step 4: Performing rolling update..."
    CONTAINERS_STOPPED=true
    
    # Update API first (with health check)
    log_info "Updating API service..."
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps --build api
    sleep 5
    
    # Update Socket service
    log_info "Updating Socket service..."
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps --build socket
    sleep 5
    
    # Update background workers (these can be updated together)
    log_info "Updating background workers..."
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps --build matchmaking cron
    
    # Update nginx last
    log_info "Updating NGINX..."
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps nginx
    
    # ============================================
    # Step 5: Verify deployment health
    # ============================================
    log_info "Step 5: Verifying deployment health..."
    if ! wait_for_health; then
        log_error "Health check failed after deployment!"
        rollback
    fi
    
    # ============================================
    # Step 6: Cleanup old images
    # ============================================
    log_info "Step 6: Cleaning up old Docker images..."
    docker image prune -f > /dev/null 2>&1 || true
    
    # ============================================
    # Step 7: Save deployment info
    # ============================================
    log_info "Step 7: Saving deployment info..."
    cat > "$BACKUP_DIR/last-deployment.txt" << EOF
Deployment Time: $(date)
Commit: $NEW_COMMIT
Previous Commit: $PREVIOUS_COMMIT
Branch: $BRANCH
EOF
    
    # ============================================
    # Final Status
    # ============================================
    echo ""
    echo "============================================"
    log_success "🎉 Deployment completed successfully!"
    echo "============================================"
    echo ""
    
    log_info "Container Status:"
    docker-compose -f "$COMPOSE_FILE" ps
    
    echo ""
    log_info "API Logs (last 10 lines):"
    docker-compose -f "$COMPOSE_FILE" logs --tail=10 api 2>/dev/null || true
    
    echo ""
    echo "============================================"
    echo "✅ Deployment finished at $(date)"
    echo "============================================"
}

# Run main function
main "$@"