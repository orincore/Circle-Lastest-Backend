#!/bin/bash

# Circle App Deployment Script
# This script sets up and deploys the optimized Circle backend for production

set -e  # Exit on any error

echo "🚀 Starting Circle App Deployment..."

# Configuration
NODE_ENV=${NODE_ENV:-production}
PORT=${PORT:-3000}
REDIS_HOST=${REDIS_HOST:-localhost}
REDIS_PORT=${REDIS_PORT:-6379}
INSTANCES=${INSTANCES:-3}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed"
        exit 1
    fi
    
    # Check Docker (for Redis)
    if ! command -v docker &> /dev/null; then
        log_warn "Docker is not installed. You'll need to set up Redis manually."
    fi
    
    # Check PM2
    if ! command -v pm2 &> /dev/null; then
        log_info "Installing PM2 globally..."
        npm install -g pm2
    fi
    
    log_info "Prerequisites check completed ✅"
}

# Install dependencies
install_dependencies() {
    log_info "Installing dependencies..."
    
    # Install backend dependencies
    npm install
    
    # Install Redis if not available
    if ! command -v redis-cli &> /dev/null; then
        log_info "Redis CLI not found. Starting Redis with Docker..."
        if command -v docker &> /dev/null; then
            docker-compose up -d redis
        else
            log_error "Please install Redis manually or install Docker to use the provided docker-compose.yml"
            exit 1
        fi
    fi
    
    log_info "Dependencies installed ✅"
}

# Build the application
build_application() {
    log_info "Building application..."
    
    # Compile TypeScript
    npm run build
    
    log_info "Application built ✅"
}

# Setup Redis
setup_redis() {
    log_info "Setting up Redis..."
    
    # Check if Redis is running
    if redis-cli -h $REDIS_HOST -p $REDIS_PORT ping &> /dev/null; then
        log_info "Redis is already running ✅"
    else
        log_info "Starting Redis with Docker Compose..."
        docker-compose up -d redis
        
        # Wait for Redis to be ready
        for i in {1..30}; do
            if redis-cli -h $REDIS_HOST -p $REDIS_PORT ping &> /dev/null; then
                log_info "Redis is ready ✅"
                break
            fi
            sleep 1
        done
        
        if ! redis-cli -h $REDIS_HOST -p $REDIS_PORT ping &> /dev/null; then
            log_error "Redis failed to start"
            exit 1
        fi
    fi
}

# Setup Nginx (optional)
setup_nginx() {
    if command -v nginx &> /dev/null; then
        log_info "Setting up Nginx load balancer..."
        
        # Copy nginx configuration
        sudo cp nginx.conf /etc/nginx/sites-available/circle-app
        sudo ln -sf /etc/nginx/sites-available/circle-app /etc/nginx/sites-enabled/
        
        # Test nginx configuration
        if sudo nginx -t; then
            sudo systemctl reload nginx
            log_info "Nginx configured ✅"
        else
            log_warn "Nginx configuration test failed. Please check nginx.conf"
        fi
    else
        log_warn "Nginx not installed. Skipping load balancer setup."
    fi
}

# Create PM2 ecosystem file
create_pm2_config() {
    log_info "Creating PM2 configuration..."
    
    cat > ecosystem.config.js << EOF
module.exports = {
  apps: [
    {
      name: 'circle-api-1',
      script: 'dist/server/app.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: '${NODE_ENV}',
        PORT: 3000,
        REDIS_HOST: '${REDIS_HOST}',
        REDIS_PORT: '${REDIS_PORT}',
        INSTANCE_ID: '1'
      },
      error_file: './logs/circle-api-1-error.log',
      out_file: './logs/circle-api-1-out.log',
      log_file: './logs/circle-api-1-combined.log',
      time: true
    },
    {
      name: 'circle-api-2',
      script: 'dist/server/app.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: '${NODE_ENV}',
        PORT: 3001,
        REDIS_HOST: '${REDIS_HOST}',
        REDIS_PORT: '${REDIS_PORT}',
        INSTANCE_ID: '2'
      },
      error_file: './logs/circle-api-2-error.log',
      out_file: './logs/circle-api-2-out.log',
      log_file: './logs/circle-api-2-combined.log',
      time: true
    },
    {
      name: 'circle-api-3',
      script: 'dist/server/app.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: '${NODE_ENV}',
        PORT: 3002,
        REDIS_HOST: '${REDIS_HOST}',
        REDIS_PORT: '${REDIS_PORT}',
        INSTANCE_ID: '3'
      },
      error_file: './logs/circle-api-3-error.log',
      out_file: './logs/circle-api-3-out.log',
      log_file: './logs/circle-api-3-combined.log',
      time: true
    },
    {
      name: 'circle-matchmaking-worker',
      script: 'dist/server/workers/matchmaking-worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: '${NODE_ENV}',
        REDIS_HOST: '${REDIS_HOST}',
        REDIS_PORT: '${REDIS_PORT}'
      },
      error_file: './logs/matchmaking-worker-error.log',
      out_file: './logs/matchmaking-worker-out.log',
      log_file: './logs/matchmaking-worker-combined.log',
      time: true
    }
  ]
};
EOF
    
    log_info "PM2 configuration created ✅"
}

# Create logs directory
setup_logging() {
    log_info "Setting up logging..."
    
    mkdir -p logs
    
    # Setup log rotation
    cat > logrotate.conf << EOF
./logs/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    copytruncate
}
EOF
    
    log_info "Logging setup completed ✅"
}

# Deploy application
deploy_application() {
    log_info "Deploying application with PM2..."
    
    # Stop existing processes
    pm2 delete all 2>/dev/null || true
    
    # Start new processes
    pm2 start ecosystem.config.js
    
    # Save PM2 configuration
    pm2 save
    
    # Setup PM2 startup script
    pm2 startup
    
    log_info "Application deployed ✅"
}

# Health check
health_check() {
    log_info "Performing health check..."
    
    sleep 5  # Wait for services to start
    
    # Check each instance
    for port in 3000 3001 3002; do
        if curl -f http://localhost:$port/health &> /dev/null; then
            log_info "Instance on port $port is healthy ✅"
        else
            log_error "Instance on port $port is not responding"
            return 1
        fi
    done
    
    # Check Redis
    if redis-cli -h $REDIS_HOST -p $REDIS_PORT ping &> /dev/null; then
        log_info "Redis is healthy ✅"
    else
        log_error "Redis is not responding"
        return 1
    fi
    
    log_info "All health checks passed ✅"
}

# Show status
show_status() {
    log_info "Deployment Status:"
    echo ""
    
    # PM2 status
    pm2 status
    echo ""
    
    # Redis status
    echo "Redis Status:"
    redis-cli -h $REDIS_HOST -p $REDIS_PORT info server | grep redis_version
    echo ""
    
    # Show URLs
    echo "API Endpoints:"
    echo "  - Instance 1: http://localhost:3000"
    echo "  - Instance 2: http://localhost:3001"
    echo "  - Instance 3: http://localhost:3002"
    echo ""
    echo "Monitoring:"
    echo "  - PM2 Monitor: pm2 monit"
    echo "  - Logs: pm2 logs"
    echo "  - Redis UI: http://localhost:8081 (if using docker-compose)"
    echo ""
}

# Cleanup function
cleanup() {
    log_info "Cleaning up temporary files..."
    # Add any cleanup tasks here
}

# Main deployment flow
main() {
    log_info "Circle App Deployment Started"
    echo "Environment: $NODE_ENV"
    echo "Instances: $INSTANCES"
    echo "Redis: $REDIS_HOST:$REDIS_PORT"
    echo ""
    
    check_prerequisites
    install_dependencies
    build_application
    setup_redis
    setup_logging
    create_pm2_config
    deploy_application
    setup_nginx
    
    if health_check; then
        show_status
        log_info "🎉 Deployment completed successfully!"
        echo ""
        echo "Your Circle app is now running with optimized matchmaking!"
        echo "The system can now handle thousands of concurrent users."
    else
        log_error "❌ Deployment failed health check"
        exit 1
    fi
}

# Handle script interruption
trap cleanup EXIT

# Run main function
main "$@"
