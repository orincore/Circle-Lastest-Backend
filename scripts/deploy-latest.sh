#!/bin/bash
set -euo pipefail

cd /root/Circle-Lastest-Backend

echo "🔄 Rebuilding and updating services from local Dockerfiles..."
docker-compose -f docker-compose.production.yml up -d --build

echo "✅ Current container status:"
docker-compose -f docker-compose.production.yml ps