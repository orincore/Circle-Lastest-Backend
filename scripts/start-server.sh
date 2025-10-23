#!/bin/bash

# Start Circle Backend without building - Direct TypeScript execution
# Perfect for 2GB RAM servers to avoid memory-intensive build process

echo "🚀 Starting Circle Backend (TypeScript Direct Mode)"

# Check if tsx is available
if ! command -v npx tsx &> /dev/null; then
    echo "❌ tsx not found. Installing..."
    npm install tsx
fi

# Function to show memory usage
show_memory() {
    echo "📊 Current Memory Usage:"
    free -h | grep -E "Mem|Swap"
    echo "---"
}

# Function to check if server is already running
check_existing() {
    if pgrep -f "tsx.*src/index.ts" > /dev/null; then
        echo "⚠️  Server already running. Stopping existing process..."
        pkill -f "tsx.*src/index.ts"
        sleep 3
    fi
}

# Pre-flight checks
echo "🔍 Pre-flight checks..."
show_memory
check_existing

# Set environment variables for production
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=512"

echo "🎯 Environment: $NODE_ENV"
echo "🧠 Node Memory Limit: 512MB"

# Start the server
echo "▶️  Starting server..."
npm run start:ts-production

# If we get here, the server stopped
echo "🛑 Server stopped"
