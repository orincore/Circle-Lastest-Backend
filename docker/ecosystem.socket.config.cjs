/**
 * PM2 Ecosystem Configuration - Socket.IO Server
 * 
 * Socket.IO with Redis adapter allows horizontal scaling.
 * Running single instance per container, scale via Docker replicas.
 */

module.exports = {
  apps: [
    {
      name: 'circle-socket',
      script: './dist/index.js',
      
      // Single instance - Socket.IO scales via Redis adapter
      // Multiple containers can be run via Docker Compose scaling
      instances: 1,
      exec_mode: 'fork',
      
      // Memory management
      max_memory_restart: '500M',
      
      // Node.js optimization flags for WebSocket handling
      node_args: [
        '--max-old-space-size=450',
        '--optimize-for-size'
      ].join(' '),
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        PORT: 8081,
        SERVICE_TYPE: 'socket',
        // Enable Redis adapter for Socket.IO scaling
        SOCKET_REDIS_ENABLED: 'true'
      },
      
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/dev/stderr',
      out_file: '/dev/stdout',
      merge_logs: true,
      
      // Graceful shutdown (longer for WebSocket connections)
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 15000,
      
      // Auto-restart settings
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      
      // Watch disabled in production
      watch: false,
      
      // Exponential backoff restart delay
      exp_backoff_restart_delay: 100
    }
  ]
};
