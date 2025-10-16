#!/bin/bash

# Restart Face Verification Service
# Use this after making code changes

echo "🔄 Restarting Face Verification Service..."

# Stop the service
./stop.sh

# Wait a moment
sleep 2

# Start the service
./start-pm2.sh

echo "✅ Service restarted!"
echo "📊 Check status with: pm2 status"
echo "📋 View logs with: pm2 logs face-verification"
