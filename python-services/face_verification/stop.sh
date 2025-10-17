#!/bin/bash

# Face Verification Service - Stop Script
# Stops the PM2 service

echo "🛑 Stopping Face Verification Service..."

if command -v pm2 &> /dev/null; then
    pm2 stop face-verification 2>/dev/null || echo "Service not running"
    pm2 delete face-verification 2>/dev/null || echo "Service not in PM2"
    echo "✅ Service stopped"
else
    echo "⚠️  PM2 not installed. If running manually, use Ctrl+C to stop."
fi
