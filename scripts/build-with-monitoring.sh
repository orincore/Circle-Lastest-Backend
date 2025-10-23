#!/bin/bash

# Build script with memory monitoring for Ubuntu 2GB RAM server

echo "🚀 Starting build with memory monitoring..."

# Function to show memory usage
show_memory() {
    echo "📊 Memory Usage:"
    free -h | grep -E "Mem|Swap"
    echo "---"
}

# Function to cleanup before build
cleanup_memory() {
    echo "🧹 Cleaning up memory..."
    
    # Clear page cache, dentries and inodes
    sudo sync
    sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'
    
    # Force garbage collection if Node.js is running
    pkill -f "node.*tsc" 2>/dev/null || true
    
    sleep 2
}

# Function to monitor build process
monitor_build() {
    local build_pid=$1
    
    while kill -0 $build_pid 2>/dev/null; do
        memory_usage=$(free | awk 'NR==2{printf "%.1f", $3*100/$2}')
        swap_usage=$(free | awk 'NR==3{if($2>0) printf "%.1f", $3*100/$2; else print "0"}')
        
        echo "Memory: ${memory_usage}% | Swap: ${swap_usage}%"
        
        # If memory usage is too high, trigger cleanup
        if (( $(echo "$memory_usage > 90" | bc -l) )); then
            echo "⚠️  High memory usage detected, triggering cleanup..."
            sudo sh -c 'echo 1 > /proc/sys/vm/drop_caches'
        fi
        
        sleep 10
    done
}

# Pre-build setup
show_memory
cleanup_memory
show_memory

echo "🔨 Starting TypeScript compilation..."

# Start build in background and monitor
npm run build:fast &
BUILD_PID=$!

# Monitor the build process
monitor_build $BUILD_PID

# Wait for build to complete
wait $BUILD_PID
BUILD_EXIT_CODE=$?

echo "✅ Build completed with exit code: $BUILD_EXIT_CODE"
show_memory

exit $BUILD_EXIT_CODE
