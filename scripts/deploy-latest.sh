#!/bin/bash
set -euo pipefail

cd /root/Circle-Lastest-Backend

echo "📦 Pulling latest images (TAG=latest)..."
export TAG=latest
docker-compose -f docker-compose.production.yml pull

echo "🔄 Updating services..."
docker-compose -f docker-compose.production.yml up -d

echo "✅ Current container status:"
docker-compose -f docker-compose.production.yml ps