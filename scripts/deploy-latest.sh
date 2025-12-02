#!/bin/bash
set -euo pipefail

cd /root/Circle-Lastest-Backend

echo "============================================"
echo "🚀 Circle Backend Deployment Script"
echo "============================================"

# Step 1: Pull latest code from git
echo ""
echo "📥 Pulling latest code from git..."
git fetch --all
git checkout main
git reset --hard origin/main
git pull origin main

echo ""
echo "📋 Latest commit:"
git log -1 --oneline

# Step 2: Stop old containers gracefully
echo ""
echo "🛑 Stopping existing containers..."
docker-compose -f docker-compose.production.yml down --remove-orphans || true

# Step 3: Clean up old images to ensure fresh build
echo ""
echo "🧹 Cleaning up old images..."
docker image prune -f

# Step 4: Build fresh images with no cache
echo ""
echo "🏗️ Building fresh Docker images (no cache)..."
docker-compose -f docker-compose.production.yml build --no-cache --pull

# Step 5: Start all services
echo ""
echo "🔄 Starting all services..."
docker-compose -f docker-compose.production.yml up -d

# Step 6: Wait for health checks
echo ""
echo "⏳ Waiting for services to become healthy..."
sleep 10

# Step 7: Show status
echo ""
echo "✅ Deployment complete! Current container status:"
docker-compose -f docker-compose.production.yml ps

echo ""
echo "📊 Container logs (last 20 lines from API):"
docker-compose -f docker-compose.production.yml logs --tail=20 api

echo ""
echo "============================================"
echo "✅ Deployment finished at $(date)"
echo "============================================"