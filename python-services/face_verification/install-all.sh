#!/bin/bash

# Complete Installation Script for Linux Server
# This script does everything: installs Python, sets up environment, and starts the service

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════╗"
echo "║   Face Verification Service - Complete Installation   ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Make all scripts executable
chmod +x setup.sh start.sh start-pm2.sh stop.sh

# Run setup
echo "Step 1/3: Running setup..."
./setup.sh

echo ""
echo "Step 2/3: Configuring environment..."

# Check if .env exists, if not create from example
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "⚠️  Created .env file from template"
    echo ""
    echo "⚠️  IMPORTANT: Please configure your AWS credentials in .env"
    echo ""
    read -p "Do you want to edit .env now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        nano .env
    else
        echo "⚠️  Remember to edit .env before starting the service!"
        echo "   nano .env"
        exit 0
    fi
fi

echo ""
echo "Step 3/3: Starting service with PM2..."
echo ""

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2..."
    sudo npm install -g pm2
    echo "✅ PM2 installed"
fi

# Start the service with PM2
./start-pm2.sh

# Setup PM2 to start on system boot
echo ""
echo "🔧 Configuring PM2 to start on boot..."
pm2 startup | grep -E "^sudo" | bash || true
pm2 save

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║              Installation Complete! 🎉                 ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "✅ Service is running with PM2"
echo "✅ PM2 will auto-start on system reboot"
echo ""
echo "📊 Service Status:"
pm2 status
echo ""
echo "📝 Useful commands:"
echo "  pm2 logs face-verification  - View logs"
echo "  pm2 restart face-verification - Restart service"
echo "  pm2 stop face-verification  - Stop service"
echo "  ./stop.sh                   - Stop and remove service"
echo ""
