#!/bin/sh
# API Container Entrypoint
# Ensures OTA directories exist and have correct permissions before starting the app

set -e

echo "🚀 [API Entrypoint] Starting initialization..."

# Create OTA directories if they don't exist
# These are on a shared volume, so we need to ensure they exist with correct ownership
mkdir -p /app/public/updates/manifests /app/public/updates/bundles

# Fix ownership to nodejs user (uid 1001, gid 1001)
chown -R 1001:1001 /app/public/updates

echo "✅ [API Entrypoint] OTA directories ready with correct permissions"
ls -la /app/public/updates/

echo "🚀 [API Entrypoint] Starting PM2 as nodejs user..."

# Execute PM2 directly - the container is already running as nodejs user
exec "$@"
