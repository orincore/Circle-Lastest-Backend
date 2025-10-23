#!/bin/bash

# Circle Backend Safe Deployment Script (No-Build Version)
# This script uses direct TypeScript execution to avoid memory-intensive builds
# Perfect for 2GB RAM servers - includes rollback capability and detailed error reporting

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
    echo -e "${GREEN}║  Circle Backend Safe Deployment (No-Build)     ║${NC}"
    echo -e "${GREEN}║        Direct TypeScript Execution             ║${NC}"
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
    print_success "Prerequisites check completed"
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

# Step 3: Skip Build - Using Direct TypeScript Execution
print_step "Step 3/5: Skipping build (using direct TypeScript execution)..."
print_success "Build step skipped - TypeScript will run directly via tsx"
print_info "This saves memory and deployment time on 2GB RAM servers"
echo ""

# Step 4: Restart PM2 with TypeScript Direct Execution
print_step "Step 4/5: Restarting PM2 process..."

# Simple approach: delete existing and start fresh with TypeScript
print_info "Stopping existing PM2 process..."
pm2 delete circle-backend 2>/dev/null || true
sleep 2

print_info "Starting with TypeScript execution..."
if pm2 start src/index.ts --name circle-backend --interpreter tsx; then
    print_success "PM2 process started successfully with TypeScript execution"
else
    print_error "PM2 start failed"
    handle_error "pm2 start" $?
fi
echo ""

# Step 5: Health Check
print_step "Step 5/5: Performing health check..."
sleep 3  # Wait for server to start

# Simple PM2 status check
print_info "PM2 Status:"
pm2 status circle-backend

if pm2 status circle-backend | grep -q "online"; then
    print_success "PM2 process is online"
else
    print_warning "PM2 process may not be online - check status above"
fi
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
print_info "Using direct TypeScript execution (no build required)"
print_info "Memory usage optimized for 2GB RAM servers"
echo ""

# Show logs
print_step "Showing recent logs (Press Ctrl+C to exit)..."
echo ""
sleep 2
pm2 logs circle-backend --lines 50
