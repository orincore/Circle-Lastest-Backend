#!/bin/sh
# API Container Entrypoint
# Ensures OTA directories exist and have correct permissions before starting the app
# This script runs as root, creates directories, fixes permissions, then drops to nodejs user

set -e

echo "🚀 [API Entrypoint] Starting initialization as $(whoami)..."

# Create OTA directories if they don't exist
# These are on a shared volume, so we need to ensure they exist with correct ownership
mkdir -p /app/public/updates/manifests /app/public/updates/bundles

# Fix ownership to nodejs user (uid 1001)
chown -R 1001:1001 /app/public/updates

echo "✅ [API Entrypoint] OTA directories ready with correct permissions"
ls -la /app/public/updates/

# Fix permissions on stdout/stderr so nodejs user can write to them
chmod 666 /dev/stdout /dev/stderr 2>/dev/null || true

echo "🚀 [API Entrypoint] Switching to nodejs user and starting PM2..."

# Switch to nodejs user and execute the main command
exec su-exec nodejs "$@"
