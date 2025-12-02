#!/bin/bash
# ============================================
# Circle Backend - Docker Deployment Script
# Production deployment with zero-downtime
# ============================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
TAG="${TAG:-latest}"
HEALTH_CHECK_RETRIES=30
HEALTH_CHECK_INTERVAL=5

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

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed!"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
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

health_check() {
    local service=$1
    local port=$2
    local retries=$HEALTH_CHECK_RETRIES
    
    log_info "Waiting for $service health check..."
    
    for i in $(seq 1 $retries); do
        if docker-compose -f "$COMPOSE_FILE" exec -T "$service" \
            wget -q --spider "http://localhost:$port/health" 2>/dev/null; then
            log_success "$service is healthy!"
            return 0
        fi
        
        if [ $i -eq $retries ]; then
            log_error "$service health check failed after $retries attempts!"
            docker-compose -f "$COMPOSE_FILE" logs --tail=50 "$service"
            return 1
        fi
        
        echo "  Waiting... ($i/$retries)"
        sleep $HEALTH_CHECK_INTERVAL
    done
}

deploy_service() {
    local service=$1
    local port=$2
    
    log_info "Deploying $service..."
    
    # Pull latest image
    docker-compose -f "$COMPOSE_FILE" pull "$service" 2>/dev/null || true
    
    # Update service with zero-downtime
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps --build "$service"
    
    # Health check if port is provided
    if [ -n "$port" ]; then
        health_check "$service" "$port"
    fi
}

# Main deployment function
deploy() {
    log_info "Starting Circle Backend deployment..."
    log_info "Using compose file: $COMPOSE_FILE"
    log_info "Tag: $TAG"
    
    check_prerequisites
    
    # Export tag for docker-compose
    export TAG
    
    # Start Redis first (if not running)
    log_info "Ensuring Redis is running..."
    docker-compose -f "$COMPOSE_FILE" up -d redis
    sleep 5
    
    # Deploy API server
    deploy_service "api" "8080"
    
    # Deploy Socket server
    deploy_service "socket" "8081"
    
    # Deploy workers (no health check ports)
    log_info "Deploying matchmaking worker..."
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps --build matchmaking
    
    log_info "Deploying cron worker..."
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps --build cron
    
    # Reload NGINX
    log_info "Reloading NGINX..."
    docker-compose -f "$COMPOSE_FILE" exec -T nginx nginx -s reload 2>/dev/null || \
        docker-compose -f "$COMPOSE_FILE" up -d --no-deps nginx
    
    # Cleanup old images
    log_info "Cleaning up old images..."
    docker image prune -f --filter "until=24h" 2>/dev/null || true
    
    log_success "Deployment complete!"
    
    # Show status
    echo ""
    log_info "Current container status:"
    docker-compose -f "$COMPOSE_FILE" ps
    
    echo ""
    log_info "Resource usage:"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null || true
}

# Rollback function
rollback() {
    local previous_tag="${1:-previous}"
    
    log_warning "Rolling back to tag: $previous_tag"
    
    export TAG="$previous_tag"
    
    docker-compose -f "$COMPOSE_FILE" up -d api socket matchmaking cron
    
    log_success "Rollback complete!"
}

# Status function
status() {
    log_info "Circle Backend Status"
    echo ""
    
    docker-compose -f "$COMPOSE_FILE" ps
    
    echo ""
    log_info "Resource Usage:"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"
    
    echo ""
    log_info "Recent Logs (last 10 lines per service):"
    for service in api socket matchmaking cron; do
        echo ""
        echo "=== $service ==="
        docker-compose -f "$COMPOSE_FILE" logs --tail=10 "$service" 2>/dev/null || echo "Service not running"
    done
}

# Stop function
stop() {
    log_warning "Stopping all services..."
    docker-compose -f "$COMPOSE_FILE" down
    log_success "All services stopped!"
}

# Logs function
logs() {
    local service="${1:-}"
    
    if [ -n "$service" ]; then
        docker-compose -f "$COMPOSE_FILE" logs -f "$service"
    else
        docker-compose -f "$COMPOSE_FILE" logs -f
    fi
}

# Build function
build() {
    log_info "Building all images..."
    
    docker-compose -f "$COMPOSE_FILE" build --parallel
    
    log_success "Build complete!"
}

# Help function
show_help() {
    echo "Circle Backend Docker Deployment Script"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  deploy              Deploy all services with zero-downtime"
    echo "  rollback [tag]      Rollback to previous version"
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
    echo "  $0 deploy"
    echo "  $0 rollback v1.2.3"
    echo "  $0 logs api"
    echo "  TAG=v1.0.0 $0 deploy"
}

# Main
case "${1:-}" in
    deploy)
        deploy
        ;;
    rollback)
        rollback "${2:-}"
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
