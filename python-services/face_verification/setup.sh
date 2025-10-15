#!/bin/bash

# Face Verification Service - Setup Script for Linux
# This script installs Python 3.11, creates virtual environment, and installs dependencies

set -e  # Exit on error

echo "🚀 Setting up Face Verification Service..."

# Check if running on Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    echo "⚠️  This script is designed for Linux servers"
    echo "For macOS, use: brew install python@3.11 && python3.11 -m venv venv"
    exit 1
fi

# Update package list
echo "📦 Updating package list..."
sudo apt-get update

# Install Python 3.11 if not already installed
if ! command -v python3.11 &> /dev/null; then
    echo "🐍 Installing Python 3.11..."
    sudo apt-get install -y software-properties-common
    sudo add-apt-repository -y ppa:deadsnakes/ppa
    sudo apt-get update
    sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
    echo "✅ Python 3.11 installed"
else
    echo "✅ Python 3.11 already installed"
fi

# Install pip for Python 3.11
if ! python3.11 -m pip --version &> /dev/null; then
    echo "📦 Installing pip for Python 3.11..."
    curl -sS https://bootstrap.pypa.io/get-pip.py | sudo python3.11
    echo "✅ pip installed"
else
    echo "✅ pip already installed"
fi

# Install system dependencies for OpenCV and MediaPipe
echo "📦 Installing system dependencies..."
sudo apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    libgstreamer1.0-0 \
    libavcodec-dev \
    libavformat-dev \
    libswscale-dev

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "🔧 Creating virtual environment..."
    python3.11 -m venv venv
    echo "✅ Virtual environment created"
else
    echo "✅ Virtual environment already exists"
fi

# Activate virtual environment and install dependencies
echo "📦 Installing Python dependencies..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo ""
echo "✅ Setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. Copy .env.example to .env and configure AWS credentials:"
echo "   cp .env.example .env"
echo "   nano .env"
echo ""
echo "2. Start the service:"
echo "   ./start.sh"
echo ""
echo "3. Or use PM2 for production:"
echo "   ./start-pm2.sh"
echo ""
