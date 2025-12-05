/**
 * PM2 Ecosystem Configuration - API Server
 * 
 * This config runs the API server in cluster mode to utilize all CPU cores.
 * Optimized for 8GB RAM / 2 vCPU instance.
 */

module.exports = {
  apps: [
    {
      name: 'circle-api',
      script: './dist/index.js',
      
      // Cluster mode - use all available CPUs
      instances: 'max',
      exec_mode: 'cluster',
      
      // Memory management (per instance)
      max_memory_restart: '400M',
      
      // Node.js optimization flags
      node_args: '--max-old-space-size=384',
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        SERVICE_TYPE: 'api'
      },
      
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/dev/stderr',
      out_file: '/dev/stdout',
      merge_logs: true,
      
      // Graceful shutdown - fast for zero-downtime deploys
      kill_timeout: 3000,
      wait_ready: true,
      listen_timeout: 8000,
      shutdown_with_message: true,
      
      // Auto-restart settings - aggressive recovery
      autorestart: true,
      max_restarts: 15,
      min_uptime: '5s',
      restart_delay: 500,
      
      // Watch disabled in production
      watch: false,
      
      // Exponential backoff restart delay
      exp_backoff_restart_delay: 100
    }
  ]
};
