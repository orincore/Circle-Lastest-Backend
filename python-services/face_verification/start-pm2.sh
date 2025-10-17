#!/bin/bash

# Face Verification Service - PM2 Start Script
# Starts the service using PM2 for production deployment

set -e  # Exit on error

echo "🚀 Starting Face Verification Service with PM2..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 not found!"
    echo "Installing PM2..."
    sudo npm install -g pm2
fi

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "❌ Virtual environment not found!"
    echo "Please run ./setup.sh first"
    exit 1
fi

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found!"
    echo "Creating from .env.example..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your AWS credentials before starting"
    exit 1
fi

# Get the absolute path to the virtual environment Python
VENV_PYTHON="$(pwd)/venv/bin/python3"

# Verify Python interpreter exists
if [ ! -f "$VENV_PYTHON" ]; then
    echo "❌ Python interpreter not found at: $VENV_PYTHON"
    exit 1
fi

echo "Using Python interpreter: $VENV_PYTHON"

# Create logs directory
mkdir -p logs

# Stop existing instance if running
pm2 delete face-verification 2>/dev/null || true

# Start with PM2 using ecosystem config
echo "✅ Starting with PM2..."
pm2 start ecosystem.config.cjs

# Save PM2 configuration
pm2 save

echo ""
echo "✅ Face Verification Service started!"
echo ""
echo "📊 Useful PM2 commands:"
echo "  pm2 status                  - View service status"
echo "  pm2 logs face-verification  - View logs"
echo "  pm2 restart face-verification - Restart service"
echo "  pm2 stop face-verification  - Stop service"
echo "  pm2 delete face-verification - Remove from PM2"
echo ""
echo "🌐 Service running on http://localhost:5000"
echo ""

# Show status
pm2 status
