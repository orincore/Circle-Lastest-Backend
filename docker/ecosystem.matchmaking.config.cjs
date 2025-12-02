/**
 * PM2 Ecosystem Configuration - Matchmaking Worker
 * 
 * Background worker for matchmaking processing.
 * Uses distributed locking via Redis to prevent duplicate processing.
 */

module.exports = {
  apps: [
    {
      name: 'circle-matchmaking',
      script: './dist/server/workers/matchmaking-worker.js',
      
      // Single instance - uses Redis distributed lock
      instances: 1,
      exec_mode: 'fork',
      
      // Memory management (worker is lightweight)
      max_memory_restart: '200M',
      
      // Node.js optimization flags
      node_args: [
        '--max-old-space-size=180',
        '--optimize-for-size'
      ].join(' '),
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        SERVICE_TYPE: 'matchmaking-worker'
      },
      
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/dev/stderr',
      out_file: '/dev/stdout',
      merge_logs: true,
      
      // Graceful shutdown
      kill_timeout: 5000,
      
      // Auto-restart settings
      autorestart: true,
      max_restarts: 20,
      min_uptime: '5s',
      restart_delay: 3000,
      
      // Watch disabled in production
      watch: false,
      
      // Cron restart - restart daily at 4 AM to prevent memory leaks
      cron_restart: '0 4 * * *',
      
      // Exponential backoff restart delay
      exp_backoff_restart_delay: 500
    }
  ]
};
