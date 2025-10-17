#!/bin/bash

# Face Verification Service - Start Script
# Starts the Flask server in the virtual environment

set -e  # Exit on error

echo "🚀 Starting Face Verification Service..."

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

# Activate virtual environment
source venv/bin/activate

# Check if dependencies are installed
if ! python -c "import flask" 2>/dev/null; then
    echo "❌ Dependencies not installed!"
    echo "Please run ./setup.sh first"
    exit 1
fi

echo "✅ Environment ready"
echo "🌐 Starting server on http://0.0.0.0:5000"
echo "Press Ctrl+C to stop"
echo ""

# Start the Flask app
python app.py
