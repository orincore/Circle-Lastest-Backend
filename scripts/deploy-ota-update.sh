#!/bin/bash

# Deploy OTA Update Script
# This script builds and deploys OTA updates to the self-hosted server

set -e

echo "🚀 Starting OTA Update Deployment..."

# Configuration
BACKEND_URL="${BACKEND_URL:-https://api.circle.orincore.com}"
INTERNAL_API_KEY="${INTERNAL_API_KEY:-your-internal-api-key}"
RUNTIME_VERSION="${RUNTIME_VERSION:-1.0.0}"
# Expo/React Native app repo on the server
CIRCLE_DIR="/root/CircleReact"
# Backend repo on the server (matches Jenkins DEPLOY_DIR)
BACKEND_DIR="/root/Circle-Lastest-Backend"
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

update_repo() {
    local dir="$1"
    local branch="$2"

    if [ ! -d "$dir/.git" ]; then
        log_error "Not a git repo: $dir"
        exit 1
    fi

    cd "$dir"
    
    log_info "Cleaning local changes in $dir..."
    git clean -fd
    git reset --hard HEAD
    
    log_info "Fetching latest from origin..."
    git fetch --all
    
    log_info "Checking out $branch..."
    git checkout "$branch" || git checkout -b "$branch" "origin/$branch"
    
    log_info "Resetting to origin/$branch..."
    git reset --hard "origin/$branch"
}

# Check if directories exist
if [ ! -d "$CIRCLE_DIR" ]; then
    log_error "Circle frontend directory not found: $CIRCLE_DIR"
    exit 1
fi

if [ ! -d "$BACKEND_DIR" ]; then
    log_error "Circle backend directory not found: $BACKEND_DIR"
    exit 1
fi

# Pull latest changes
log_info "Pulling latest changes..."
update_repo "$CIRCLE_DIR" "main" || {
    log_error "Failed to pull frontend changes"
    exit 1
}

if [ "${SKIP_BACKEND_UPDATE:-false}" != "true" ]; then
    update_repo "$BACKEND_DIR" "main" || {
        log_error "Failed to pull backend changes"
        exit 1
    }
else
    log_warn "Skipping backend repo update (SKIP_BACKEND_UPDATE=true)"
fi

# Install/update dependencies
log_info "Installing frontend dependencies..."
cd "$CIRCLE_DIR"
rm -f package-lock.json
npm install --legacy-peer-deps || npm install || {
    log_warn "Frontend npm install had issues, but continuing..."
}

log_info "Installing backend dependencies (for OTA build script)..."
if [ "${SKIP_BACKEND_UPDATE:-false}" != "true" ]; then
    cd "$BACKEND_DIR"
    rm -f package-lock.json
    npm install --legacy-peer-deps || npm install || {
        log_warn "Backend npm install had issues, but continuing..."
    }
else
    log_warn "Skipping backend npm install (SKIP_BACKEND_UPDATE=true)"
fi

# Build OTA updates
log_info "Building OTA updates..."

# Ensure the build script exists in the backend repo
cd "$BACKEND_DIR"
if [ ! -f "scripts/build-ota-update.js" ]; then
    log_error "OTA build script not found in backend repo ($BACKEND_DIR/scripts/build-ota-update.js)"
    exit 1
fi

# Set environment variables for the build
# Use localhost to connect directly to NGINX on host (bypasses CloudFlare/external proxies)
# NGINX listens on host ports 80/443 and forwards to Docker containers
export BACKEND_URL="http://localhost"
export INTERNAL_API_KEY="$INTERNAL_API_KEY"
export RUNTIME_VERSION="$RUNTIME_VERSION"
export CIRCLE_APP_DIR="$CIRCLE_DIR"

# Run the OTA build script from the backend repo
# Using localhost bypasses external domain routing and CloudFlare body size limits
node scripts/build-ota-update.js || {
    log_error "Failed to build OTA updates"
    exit 1
}

# Verify updates were uploaded
log_info "Verifying OTA updates..."
RESPONSE=$(curl -s -f "http://localhost/api/updates/status" || echo "")
if [ -z "$RESPONSE" ]; then
    log_error "Failed to verify OTA updates"
    exit 1
fi

log_info "OTA update status:"
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"

# Clean up build artifacts
log_info "Cleaning up..."
cd "$CIRCLE_DIR"
rm -rf dist-updates/ || true

log_info "🎉 OTA Update deployment completed successfully!"

# Send notification (optional)
if [ -n "$SLACK_WEBHOOK_URL" ]; then
    curl -X POST -H 'Content-type: application/json' \
        --data "{\"text\":\"🚀 Circle OTA Update deployed successfully! Runtime version: $RUNTIME_VERSION\"}" \
        "$SLACK_WEBHOOK_URL" || log_warn "Failed to send Slack notification"
fi

echo "✅ OTA updates are now available to users!"
