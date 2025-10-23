#!/bin/bash

# Circle Backend Safe Deployment Script
# This script includes rollback capability and detailed error reporting

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Variables
CURRENT_COMMIT=""
DEPLOYMENT_START_TIME=$(date +%s)

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

print_info() {
    echo -e "${CYAN}ℹ${NC} $1"
}

# Function to show deployment header
show_header() {
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║    Circle Backend Safe Deployment Script       ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
    echo ""
    print_info "Deployment started at: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
}

# Function to handle errors with rollback
handle_error() {
    local step=$1
    local error_code=$2
    
    echo ""
    print_error "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    print_error "Deployment failed at: $step"
    print_error "Error code: $error_code"
    print_error "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # Ask for rollback
    if [ ! -z "$CURRENT_COMMIT" ]; then
        print_warning "Would you like to rollback to previous commit? (y/n)"
        read -t 10 -n 1 rollback_choice
        echo ""
        
        if [ "$rollback_choice" = "y" ] || [ "$rollback_choice" = "Y" ]; then
            print_step "Rolling back to commit: $CURRENT_COMMIT"
            git reset --hard $CURRENT_COMMIT
            print_success "Rollback completed"
            
            print_step "Restarting PM2 with previous version..."
            pm2 restart circle-backend
        fi
    fi
    
    echo ""
    print_error "Deployment failed! Please check the errors above."
    exit 1
}

# Function to check prerequisites
check_prerequisites() {
    print_step "Checking prerequisites..."
    
    # Check if git is installed
    if ! command -v git &> /dev/null; then
        print_error "Git is not installed"
        exit 1
    fi
    
    # Check if npm is installed
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed"
        exit 1
    fi
    
    # Check if pm2 is installed
    if ! command -v pm2 &> /dev/null; then
        print_error "PM2 is not installed"
        exit 1
    fi
    
    # Check if we're in a git repository
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "Not a git repository"
        exit 1
    fi
    
    print_success "All prerequisites met"
    echo ""
}

# Function to save current state
save_current_state() {
    print_step "Saving current state..."
    CURRENT_COMMIT=$(git rev-parse HEAD)
    print_info "Current commit: $CURRENT_COMMIT"
    echo ""
}

# Function to show git status
show_git_status() {
    print_step "Current git status:"
    git status --short
    echo ""
    print_info "Current branch: $(git branch --show-current)"
    print_info "Last commit: $(git log -1 --oneline)"
    echo ""
}

# Start deployment
show_header
check_prerequisites
save_current_state
show_git_status

# Step 1: Git Pull
print_step "Step 1/5: Pulling latest code from origin/main..."
if git pull origin main 2>&1 | tee /tmp/git-pull.log; then
    NEW_COMMIT=$(git rev-parse HEAD)
    if [ "$CURRENT_COMMIT" = "$NEW_COMMIT" ]; then
        print_info "Already up to date - no new changes"
    else
        print_success "Code pulled successfully"
        print_info "New commit: $NEW_COMMIT"
        echo ""
        print_info "Changes:"
        git log --oneline $CURRENT_COMMIT..$NEW_COMMIT
    fi
else
    handle_error "git pull" $?
fi
echo ""

# Step 2: Install Dependencies
print_step "Step 2/5: Installing dependencies..."
print_info "This may take a few minutes..."
if npm install 2>&1 | tee /tmp/npm-install.log; then
    print_success "Dependencies installed successfully"
else
    print_error "npm install failed. Check /tmp/npm-install.log for details"
    handle_error "npm install" $?
fi
echo ""

# Step 3: Build TypeScript
print_step "Step 3/5: Building TypeScript..."

# Constrain Node memory for low-RAM servers (default 1536MB for 2GB machines)
if [ -z "$NODE_OPTIONS" ]; then
  export NODE_OPTIONS="--max-old-space-size=${BUILD_MAX_OLD_SPACE:-1536}"
  print_info "Using NODE_OPTIONS=$NODE_OPTIONS for tsc build"
else
  print_info "NODE_OPTIONS already set: $NODE_OPTIONS"
fi

if npm run build 2>&1 | tee /tmp/npm-build.log; then
    print_success "Build completed successfully"
else
    print_error "Build failed. Check /tmp/npm-build.log for details"
    handle_error "npm run build" $?
fi
echo ""

# Step 4: Restart PM2
print_step "Step 4/5: Restarting PM2 process..."
if pm2 restart circle-backend 2>&1 | tee /tmp/pm2-restart.log; then
    print_success "PM2 process restarted successfully"
else
    print_warning "PM2 restart failed, trying to start..."
    if pm2 start ecosystem.config.js 2>&1 | tee /tmp/pm2-start.log; then
        print_success "PM2 process started successfully"
    else
        print_error "PM2 start failed. Check /tmp/pm2-start.log for details"
        handle_error "pm2 restart/start" $?
    fi
fi
echo ""

# Step 5: Health Check
print_step "Step 5/5: Performing health check..."
sleep 3  # Wait for server to start

# Check PM2 status
PM2_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="circle-backend") | .pm2_env.status')
if [ "$PM2_STATUS" = "online" ]; then
    print_success "PM2 process is online"
else
    print_error "PM2 process is not online (Status: $PM2_STATUS)"
    handle_error "health check" 1
fi

# Show PM2 info
echo ""
print_info "PM2 Status:"
pm2 status circle-backend
echo ""

# Calculate deployment time
DEPLOYMENT_END_TIME=$(date +%s)
DEPLOYMENT_DURATION=$((DEPLOYMENT_END_TIME - DEPLOYMENT_START_TIME))

# Success message
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      Deployment Completed Successfully         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
print_success "Deployment completed in ${DEPLOYMENT_DURATION} seconds"
print_info "Deployed at: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Show logs
print_step "Showing recent logs (Press Ctrl+C to exit)..."
echo ""
sleep 2
pm2 logs circle-backend --lines 50
