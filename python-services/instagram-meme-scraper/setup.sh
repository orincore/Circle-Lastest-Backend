#!/bin/bash

# Instagram Meme Scraper - Setup Script
# Creates a virtual environment and installs dependencies.

set -e

echo "Setting up Instagram Meme Scraper service..."

PYTHON_BIN="python3"
if command -v python3.11 &> /dev/null; then
  PYTHON_BIN="python3.11"
fi

if [ ! -d "venv" ]; then
  echo "Creating virtual environment with $PYTHON_BIN..."
  "$PYTHON_BIN" -m venv venv
fi

source venv/bin/activate

echo "Installing dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

if [ ! -f ".env" ]; then
  echo "Creating .env from .env.example -- edit it with real DATABASE_URL/AWS/proxy values before starting."
  cp .env.example .env
fi

mkdir -p logs

echo "Setup complete. Edit .env, then run ./start.sh"
