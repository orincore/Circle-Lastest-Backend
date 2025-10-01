#!/bin/bash

# Circle Backend Deployment Script
# This script pulls latest code, installs dependencies, builds, and restarts the backend

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_step() {
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Function to handle errors
handle_error() {
    print_error "Error occurred in: $1"
    print_error "Deployment failed!"
    exit 1
}

# Start deployment
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Circle Backend Deployment Script    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Git Pull
print_step "Step 1/5: Pulling latest code from origin/main..."
if git pull origin main; then
    print_success "Code pulled successfully"
else
    handle_error "git pull"
fi
echo ""

# Step 2: Install Dependencies
print_step "Step 2/5: Installing dependencies..."
if npm install; then
    print_success "Dependencies installed successfully"
else
    handle_error "npm install"
fi
echo ""

# Step 3: Build TypeScript
print_step "Step 3/5: Building TypeScript..."
if npm run build; then
    print_success "Build completed successfully"
else
    handle_error "npm run build"
fi
echo ""

# Step 4: Restart PM2
print_step "Step 4/5: Restarting PM2 process..."
if pm2 restart circle-backend; then
    print_success "PM2 process restarted successfully"
else
    print_warning "PM2 restart failed, trying to start..."
    if pm2 start ecosystem.config.js; then
        print_success "PM2 process started successfully"
    else
        handle_error "pm2 restart/start"
    fi
fi
echo ""

# Step 5: Show PM2 Status
print_step "Step 5/5: Checking PM2 status..."
pm2 status
echo ""

# Success message
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Deployment Completed Successfully  ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# Show logs
print_step "Showing recent logs (Press Ctrl+C to exit)..."
echo ""
sleep 2
pm2 logs circle-backend --lines 50
