#!/bin/bash
# ============================================
# Circle Backend - Blue-Green Deployment Script
# Zero-downtime deployment with rolling updates
# ============================================
#
# Architecture:
# - Blue and Green container sets run simultaneously
# - During updates: one set is updated while other handles traffic
# - Load balancer distributes traffic across both sets
# - Automatic failover if one set is unhealthy
# ============================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
TAG="${TAG:-latest}"
HEALTH_CHECK_RETRIES=30
HEALTH_CHECK_INTERVAL=5
DRAIN_WAIT_SECONDS=10

# Service sets
BLUE_SERVICES=("api-blue" "socket-blue" "matchmaking-blue")
GREEN_SERVICES=("api-green" "socket-green" "matchmaking-green")
ALL_SERVICES=("api-blue" "api-green" "socket-blue" "socket-green" "matchmaking-blue" "matchmaking-green" "cron")

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_blue() {
    echo -e "${CYAN}[BLUE]${NC} $1"
}

log_green() {
    echo -e "${GREEN}[GREEN]${NC} $1"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed!"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "Docker Compose is not installed!"
        exit 1
    fi
    
    if [ ! -f "$COMPOSE_FILE" ]; then
        log_error "Compose file not found: $COMPOSE_FILE"
        exit 1
    fi
    
    if [ ! -f "$ENV_FILE" ]; then
        log_warning "Environment file not found: $ENV_FILE"
        log_warning "Make sure to create it from .env.example"
    fi
    
    log_success "Prerequisites check passed!"
}

# Docker compose wrapper (supports both v1 and v2)
dc() {
    if docker compose version &> /dev/null; then
        docker compose -f "$COMPOSE_FILE" "$@"
    else
        docker-compose -f "$COMPOSE_FILE" "$@"
    fi
}

health_check() {
    local service=$1
    local port=$2
    local retries=$HEALTH_CHECK_RETRIES
    
    log_info "Waiting for $service health check..."
    
    for i in $(seq 1 $retries); do
        if dc exec -T "$service" \
            wget -q --spider "http://localhost:$port/health" 2>/dev/null; then
            log_success "$service is healthy!"
            return 0
        fi
        
        if [ $i -eq $retries ]; then
            log_error "$service health check failed after $retries attempts!"
            dc logs --tail=50 "$service"
            return 1
        fi
        
        echo "  Waiting... ($i/$retries)"
        sleep $HEALTH_CHECK_INTERVAL
    done
}

# Check if a service is running and healthy
is_service_healthy() {
    local service=$1
    local port=$2
    
    if dc exec -T "$service" wget -q --spider "http://localhost:$port/health" 2>/dev/null; then
        return 0
    fi
    return 1
}

# Deploy a single service with health check
deploy_service() {
    local service=$1
    local port=$2
    
    log_info "Deploying $service..."
    
    # Build and start the service
    dc up -d --no-deps --build "$service"
    
    # Health check if port is provided
    if [ -n "$port" ]; then
        health_check "$service" "$port"
    else
        # Wait a bit for services without health endpoints
        sleep 5
    fi
}

# Deploy a color set (blue or green)
deploy_color_set() {
    local color=$1
    
    if [ "$color" = "blue" ]; then
        log_blue "Deploying BLUE set..."
        deploy_service "api-blue" "8080"
        deploy_service "socket-blue" "8081"
        deploy_service "matchmaking-blue" ""
        log_blue "BLUE set deployment complete!"
    else
        log_green "Deploying GREEN set..."
        deploy_service "api-green" "8080"
        deploy_service "socket-green" "8081"
        deploy_service "matchmaking-green" ""
        log_green "GREEN set deployment complete!"
    fi
}

# Rolling update - update one set at a time
rolling_update() {
    log_info "Starting rolling update..."
    log_info "Traffic will be handled by the healthy set during update"
    
    # Check which set is currently healthy
    local blue_healthy=false
    local green_healthy=false
    
    if is_service_healthy "api-blue" "8080" 2>/dev/null; then
        blue_healthy=true
        log_blue "Blue set is healthy"
    fi
    
    if is_service_healthy "api-green" "8080" 2>/dev/null; then
        green_healthy=true
        log_green "Green set is healthy"
    fi
    
    # Update blue first, then green
    log_info "Phase 1: Updating BLUE set (GREEN handles traffic)..."
    if $green_healthy; then
        log_info "Green set will handle all traffic during blue update"
    else
        log_warning "Green set not healthy - deploying it first for safety"
        deploy_color_set "green"
    fi
    
    # Wait for connections to drain from blue
    log_info "Waiting ${DRAIN_WAIT_SECONDS}s for connections to drain..."
    sleep $DRAIN_WAIT_SECONDS
    
    # Update blue set
    deploy_color_set "blue"
    
    log_info "Phase 2: Updating GREEN set (BLUE handles traffic)..."
    log_info "Blue set will handle all traffic during green update"
    
    # Wait for connections to drain from green
    log_info "Waiting ${DRAIN_WAIT_SECONDS}s for connections to drain..."
    sleep $DRAIN_WAIT_SECONDS
    
    # Update green set
    deploy_color_set "green"
    
    log_success "Rolling update complete! Both sets are now running the latest version."
}

# Main deployment function - full deployment
deploy() {
    log_info "Starting Circle Backend deployment..."
    log_info "Using compose file: $COMPOSE_FILE"
    log_info "Tag: $TAG"
    echo ""
    
    check_prerequisites
    
    # Export tag for docker-compose
    export TAG
    export CACHEBUST=$(date +%s)
    
    # Start Redis first (if not running)
    log_info "Ensuring Redis is running..."
    dc up -d redis
    sleep 5
    
    # Check if this is a fresh deployment or update
    local existing_containers=$(dc ps -q 2>/dev/null | wc -l)
    
    if [ "$existing_containers" -gt 2 ]; then
        # Existing deployment - do rolling update
        log_info "Existing deployment detected - performing rolling update"
        rolling_update
    else
        # Fresh deployment - start everything
        log_info "Fresh deployment - starting all services"
        deploy_color_set "blue"
        deploy_color_set "green"
    fi
    
    # Deploy cron worker (single instance)
    log_info "Deploying cron worker..."
    dc up -d --no-deps --build cron
    
    # Start/reload NGINX
    log_info "Starting/reloading NGINX..."
    dc up -d nginx
    dc exec -T nginx nginx -s reload 2>/dev/null || true
    
    # Cleanup old images
    log_info "Cleaning up old images..."
    docker image prune -f --filter "until=24h" 2>/dev/null || true
    
    log_success "Deployment complete!"
    
    # Show status
    echo ""
    status
}

# Quick update - only update services, skip infrastructure
quick_update() {
    log_info "Starting quick update (services only)..."
    
    export TAG
    export CACHEBUST=$(date +%s)
    
    rolling_update
    
    # Reload NGINX to pick up any changes
    dc exec -T nginx nginx -s reload 2>/dev/null || true
    
    log_success "Quick update complete!"
    echo ""
    status
}

# Deploy only blue set
deploy_blue() {
    log_info "Deploying BLUE set only..."
    export TAG
    export CACHEBUST=$(date +%s)
    
    deploy_color_set "blue"
    dc exec -T nginx nginx -s reload 2>/dev/null || true
    
    log_success "Blue set deployed!"
}

# Deploy only green set
deploy_green() {
    log_info "Deploying GREEN set only..."
    export TAG
    export CACHEBUST=$(date +%s)
    
    deploy_color_set "green"
    dc exec -T nginx nginx -s reload 2>/dev/null || true
    
    log_success "Green set deployed!"
}

# Rollback function - rollback a specific color set
rollback() {
    local previous_tag="${1:-previous}"
    local color="${2:-both}"
    
    log_warning "Rolling back to tag: $previous_tag"
    
    export TAG="$previous_tag"
    
    if [ "$color" = "blue" ] || [ "$color" = "both" ]; then
        log_blue "Rolling back BLUE set..."
        dc up -d api-blue socket-blue matchmaking-blue
    fi
    
    if [ "$color" = "green" ] || [ "$color" = "both" ]; then
        log_green "Rolling back GREEN set..."
        dc up -d api-green socket-green matchmaking-green
    fi
    
    dc exec -T nginx nginx -s reload 2>/dev/null || true
    
    log_success "Rollback complete!"
}

# Status function
status() {
    log_info "Circle Backend Status (Blue-Green Deployment)"
    echo ""
    
    # Container status
    echo "=== Container Status ==="
    dc ps
    
    echo ""
    echo "=== Health Status ==="
    
    # Check blue set
    echo -n "API Blue:    "
    if is_service_healthy "api-blue" "8080" 2>/dev/null; then
        echo -e "${GREEN}HEALTHY${NC}"
    else
        echo -e "${RED}UNHEALTHY${NC}"
    fi
    
    echo -n "API Green:   "
    if is_service_healthy "api-green" "8080" 2>/dev/null; then
        echo -e "${GREEN}HEALTHY${NC}"
    else
        echo -e "${RED}UNHEALTHY${NC}"
    fi
    
    echo -n "Socket Blue: "
    if is_service_healthy "socket-blue" "8081" 2>/dev/null; then
        echo -e "${GREEN}HEALTHY${NC}"
    else
        echo -e "${RED}UNHEALTHY${NC}"
    fi
    
    echo -n "Socket Green:"
    if is_service_healthy "socket-green" "8081" 2>/dev/null; then
        echo -e "${GREEN}HEALTHY${NC}"
    else
        echo -e "${RED}UNHEALTHY${NC}"
    fi
    
    echo ""
    echo "=== Resource Usage ==="
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" 2>/dev/null || true
}

# Stop function
stop() {
    log_warning "Stopping all services..."
    dc down
    log_success "All services stopped!"
}

# Logs function
logs() {
    local service="${1:-}"
    
    if [ -n "$service" ]; then
        dc logs -f "$service"
    else
        dc logs -f
    fi
}

# Build function
build() {
    log_info "Building all images..."
    
    export CACHEBUST=$(date +%s)
    dc build --parallel
    
    log_success "Build complete!"
}

# Scale function - adjust weights (for maintenance)
scale() {
    local color=$1
    local action=$2
    
    if [ "$action" = "down" ]; then
        log_warning "Scaling down $color set..."
        if [ "$color" = "blue" ]; then
            dc stop api-blue socket-blue matchmaking-blue
        else
            dc stop api-green socket-green matchmaking-green
        fi
        log_info "Traffic will be handled by the other set"
    else
        log_info "Scaling up $color set..."
        if [ "$color" = "blue" ]; then
            dc start api-blue socket-blue matchmaking-blue
        else
            dc start api-green socket-green matchmaking-green
        fi
    fi
    
    dc exec -T nginx nginx -s reload 2>/dev/null || true
}

# Help function
show_help() {
    echo "Circle Backend - Blue-Green Deployment Script"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  deploy              Full deployment with rolling update"
    echo "  quick-update        Quick rolling update (services only)"
    echo "  deploy-blue         Deploy only the blue set"
    echo "  deploy-green        Deploy only the green set"
    echo "  rollback [tag] [color]  Rollback to previous version"
    echo "  scale <color> <up|down> Scale a color set up or down"
    echo "  status              Show status of all services"
    echo "  stop                Stop all services"
    echo "  logs [service]      Show logs (optionally for specific service)"
    echo "  build               Build all Docker images"
    echo "  help                Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  COMPOSE_FILE        Docker compose file (default: docker-compose.production.yml)"
    echo "  ENV_FILE            Environment file (default: .env.production)"
    echo "  TAG                 Docker image tag (default: latest)"
    echo ""
    echo "Examples:"
    echo "  $0 deploy                    # Full deployment"
    echo "  $0 quick-update              # Rolling update services"
    echo "  $0 deploy-blue               # Update only blue set"
    echo "  $0 rollback v1.2.3           # Rollback both sets"
    echo "  $0 rollback v1.2.3 blue      # Rollback only blue set"
    echo "  $0 scale blue down           # Take blue offline for maintenance"
    echo "  $0 scale blue up             # Bring blue back online"
    echo "  $0 logs api-blue             # View blue API logs"
    echo "  TAG=v1.0.0 $0 deploy         # Deploy specific version"
}

# Main
case "${1:-}" in
    deploy)
        deploy
        ;;
    quick-update)
        quick_update
        ;;
    deploy-blue)
        deploy_blue
        ;;
    deploy-green)
        deploy_green
        ;;
    rollback)
        rollback "${2:-}" "${3:-both}"
        ;;
    scale)
        scale "${2:-}" "${3:-up}"
        ;;
    status)
        status
        ;;
    stop)
        stop
        ;;
    logs)
        logs "${2:-}"
        ;;
    build)
        build
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        show_help
        exit 1
        ;;
esac
