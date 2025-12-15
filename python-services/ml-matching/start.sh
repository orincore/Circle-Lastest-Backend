#!/bin/bash
# Start script for ML Matching Service

set -e

echo "Starting ML Matching Service..."

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install/update dependencies
echo "Installing dependencies..."
pip install -r requirements.txt

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "Warning: .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "Please edit .env file with your configuration before running."
    exit 1
fi

# Start the service
echo "Starting service on port ${SERVICE_PORT:-8090}..."
python app.py
