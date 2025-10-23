#!/bin/bash

# Chunked build strategy for 2GB RAM server
# Compiles TypeScript in smaller batches to avoid memory issues

echo "🚀 Starting chunked build for memory-constrained server..."

# Clean up
rm -rf dist
mkdir -p dist

# Function to show memory usage
show_memory() {
    free -h | grep -E "Mem|Swap" | head -2
}

# Function to cleanup memory aggressively
cleanup_memory() {
    echo "🧹 Aggressive memory cleanup..."
    sudo sync
    sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'
    pkill -f "node.*tsc" 2>/dev/null || true
    sleep 3
}

# Function to compile a specific directory
compile_chunk() {
    local chunk_name=$1
    local include_pattern=$2
    
    echo "📦 Compiling chunk: $chunk_name"
    show_memory
    
    # Create temporary tsconfig for this chunk
    cat > tsconfig.chunk.json << EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "incremental": false,
    "skipLibCheck": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["$include_pattern"],
  "exclude": [
    "node_modules",
    "dist",
    "**/*.test.ts",
    "**/*.spec.ts"
  ]
}
EOF

    # Compile with very conservative memory settings
    timeout 300 node \
        --max-old-space-size=512 \
        --optimize-for-size \
        --gc-interval=25 \
        --max-semi-space-size=32 \
        ./node_modules/.bin/tsc -p tsconfig.chunk.json
    
    local exit_code=$?
    
    # Cleanup
    rm -f tsconfig.chunk.json
    cleanup_memory
    
    if [ $exit_code -eq 0 ]; then
        echo "✅ Chunk $chunk_name completed successfully"
    elif [ $exit_code -eq 124 ]; then
        echo "⏰ Chunk $chunk_name timed out (5 minutes)"
        return 1
    else
        echo "❌ Chunk $chunk_name failed with exit code $exit_code"
        return 1
    fi
    
    return 0
}

echo "Starting chunked compilation..."
cleanup_memory

# Compile in chunks - adjust patterns based on your project structure
chunks=(
    "config:src/config/**/*.ts"
    "database:src/database/**/*.ts"
    "middleware:src/middleware/**/*.ts"
    "utils:src/utils/**/*.ts"
    "types:src/types/**/*.ts"
    "routes:src/server/routes/**/*.ts"
    "workers:src/server/workers/**/*.ts"
    "services:src/services/**/*.ts"
    "main:src/*.ts"
    "server:src/server/*.ts"
)

failed_chunks=()

for chunk in "${chunks[@]}"; do
    IFS=':' read -r chunk_name pattern <<< "$chunk"
    
    if ! compile_chunk "$chunk_name" "$pattern"; then
        failed_chunks+=("$chunk_name")
    fi
    
    # Brief pause between chunks
    sleep 2
done

# Final compilation to link everything together
echo "🔗 Final linking phase..."
cleanup_memory

node \
    --max-old-space-size=512 \
    --optimize-for-size \
    --gc-interval=25 \
    ./node_modules/.bin/tsc --build --force

final_exit_code=$?

echo "📊 Final memory status:"
show_memory

if [ ${#failed_chunks[@]} -eq 0 ] && [ $final_exit_code -eq 0 ]; then
    echo "✅ Chunked build completed successfully!"
    exit 0
else
    echo "❌ Build failed. Failed chunks: ${failed_chunks[*]}"
    echo "Final linking exit code: $final_exit_code"
    exit 1
fi
