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
cd "$CIRCLE_DIR"
git pull origin main || {
    log_error "Failed to pull frontend changes"
    exit 1
}

cd "$BACKEND_DIR"
git pull origin main || {
    log_error "Failed to pull backend changes"
    exit 1
}

# Install/update dependencies
log_info "Installing frontend dependencies..."
cd "$CIRCLE_DIR"
npm install || {
    log_error "Failed to install frontend dependencies"
    exit 1
}

log_info "Installing backend dependencies (for OTA build script)..."
cd "$BACKEND_DIR"
npm install || {
    log_error "Failed to install backend dependencies"
    exit 1
}

# Build OTA updates
log_info "Building OTA updates..."

# Ensure the build script exists in the backend repo
cd "$BACKEND_DIR"
if [ ! -f "scripts/build-ota-update.js" ]; then
    log_error "OTA build script not found in backend repo ($BACKEND_DIR/scripts/build-ota-update.js)"
    exit 1
fi

# Set environment variables for the build
export BACKEND_URL="$BACKEND_URL"
export INTERNAL_API_KEY="$INTERNAL_API_KEY"
export RUNTIME_VERSION="$RUNTIME_VERSION"
export CIRCLE_APP_DIR="$CIRCLE_DIR"

# Run the OTA build script from the backend repo
node scripts/build-ota-update.js || {
    log_error "Failed to build OTA updates"
    exit 1
}

# Verify updates were uploaded
log_info "Verifying OTA updates..."
RESPONSE=$(curl -s -f "$BACKEND_URL/api/updates/status" || echo "")
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
