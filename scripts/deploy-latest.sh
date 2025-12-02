#!/bin/bash
set -euo pipefail

cd /root/Circle-Lastest-Backend

echo "🔄 Rebuilding and updating API & Socket from local Dockerfiles..."
docker-compose -f docker-compose.production.yml up -d --build api socket

echo "🔄 Rebuilding and updating background workers..."
docker-compose -f docker-compose.production.yml up -d --build matchmaking cron

echo "🔄 Ensuring NGINX is up with latest config..."
docker-compose -f docker-compose.production.yml up -d --build nginx

echo "✅ Current container status:"
docker-compose -f docker-compose.production.yml ps