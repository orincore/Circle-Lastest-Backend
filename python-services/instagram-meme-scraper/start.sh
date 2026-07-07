#!/bin/bash

# Instagram Meme Scraper - Start Script
# Starts the scraper loop + health endpoint in the virtual environment.

set -e

echo "Starting Instagram Meme Scraper service..."

if [ ! -d "venv" ]; then
    echo "Virtual environment not found!"
    echo "Please run ./setup.sh first"
    exit 1
fi

if [ ! -f ".env" ]; then
    echo "Warning: .env file not found!"
    echo "Creating from .env.example..."
    cp .env.example .env
    echo "Please edit .env with your DATABASE_URL / AWS / proxy values before starting"
    exit 1
fi

source venv/bin/activate

if ! python -c "import flask, psycopg2, boto3" 2>/dev/null; then
    echo "Dependencies not installed!"
    echo "Please run ./setup.sh first"
    exit 1
fi

echo "Environment ready"
echo "Health check on http://0.0.0.0:${PORT:-5001}/health"
echo "Press Ctrl+C to stop"
echo ""

python app.py
