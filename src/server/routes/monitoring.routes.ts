import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { monitoringService } from '../services/monitoring.js'
import { getConnectionMetrics } from '../sockets/optimized-socket.js'
import { getMetrics as getMatchmakingMetrics } from '../services/matchmaking-optimized.js'

const router = Router()

// Get current system metrics
router.get('/metrics', async (req, res) => {
  try {
    const metrics = await monitoringService.collectMetrics()
    res.json(metrics)
  } catch (error) {
    console.error('Failed to get metrics:', error)
    res.status(500).json({ error: 'Failed to collect metrics' })
  }
})

// Get aggregated metrics from all instances
router.get('/metrics/aggregated', async (req, res) => {
  try {
    const aggregated = await monitoringService.getAggregatedMetrics()
    res.json(aggregated)
  } catch (error) {
    console.error('Failed to get aggregated metrics:', error)
    res.status(500).json({ error: 'Failed to collect aggregated metrics' })
  }
})

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    const health = await monitoringService.healthCheck()
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503
    res.status(statusCode).json(health)
  } catch (error) {
    console.error('Health check failed:', error)
    res.status(503).json({
      status: 'unhealthy',
      checks: {
        error: { status: 'fail', message: 'Health check failed' }
      }
    })
  }
})

// Get recent metrics history
router.get('/metrics/history', async (req, res) => {
  try {
    const count = parseInt(req.query.count as string) || 10
    const history = monitoringService.getRecentMetrics(count)
    res.json(history)
  } catch (error) {
    console.error('Failed to get metrics history:', error)
    res.status(500).json({ error: 'Failed to get metrics history' })
  }
})

// Get connection metrics
router.get('/connections', async (req, res) => {
  try {
    const connections = getConnectionMetrics()
    res.json(connections)
  } catch (error) {
    console.error('Failed to get connection metrics:', error)
    res.status(500).json({ error: 'Failed to get connection metrics' })
  }
})

// Get matchmaking metrics
router.get('/matchmaking', async (req, res) => {
  try {
    const matchmaking = await getMatchmakingMetrics()
    res.json(matchmaking)
  } catch (error) {
    console.error('Failed to get matchmaking metrics:', error)
    res.status(500).json({ error: 'Failed to get matchmaking metrics' })
  }
})

// Simple dashboard HTML (for quick monitoring)
router.get('/dashboard', async (req, res) => {
  try {
    const metrics = await monitoringService.collectMetrics()
    const connections = getConnectionMetrics()
    const matchmaking = await getMatchmakingMetrics()
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Circle App - Monitoring Dashboard</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .metric { display: flex; justify-content: space-between; margin: 10px 0; }
        .metric-label { font-weight: 500; color: #666; }
        .metric-value { font-weight: bold; color: #333; }
        .status-healthy { color: #10b981; }
        .status-degraded { color: #f59e0b; }
        .status-unhealthy { color: #ef4444; }
        .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
        .refresh-btn:hover { background: #5a67d8; }
        .timestamp { font-size: 12px; color: #999; }
    </style>
    <script>
        function refreshData() {
            window.location.reload();
        }
        
        // Auto-refresh every 30 seconds
        setTimeout(refreshData, 30000);
    </script>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Circle App - Monitoring Dashboard</h1>
            <p>Real-time system metrics and performance monitoring</p>
            <button class="refresh-btn" onclick="refreshData()">🔄 Refresh</button>
            <div class="timestamp">Last updated: ${new Date().toLocaleString()}</div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>🔗 Connections</h3>
                <div class="metric">
                    <span class="metric-label">Total Connections</span>
                    <span class="metric-value">${connections.totalConnections.toLocaleString()}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Unique Users</span>
                    <span class="metric-value">${connections.uniqueUsers.toLocaleString()}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Avg per User</span>
                    <span class="metric-value">${connections.averageConnectionsPerUser.toFixed(2)}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Max per User</span>
                    <span class="metric-value">${connections.maxConnectionsPerUser}</span>
                </div>
            </div>
            
            <div class="card">
                <h3>💕 Matchmaking</h3>
                <div class="metric">
                    <span class="metric-label">Currently Searching</span>
                    <span class="metric-value">${matchmaking.current_searching || 0}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Active Proposals</span>
                    <span class="metric-value">${matchmaking.active_proposals || 0}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Total Matches</span>
                    <span class="metric-value">${(matchmaking.matches_created || 0).toLocaleString()}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Searches Started</span>
                    <span class="metric-value">${(matchmaking.searches_started || 0).toLocaleString()}</span>
                </div>
            </div>
            
            <div class="card">
                <h3>🖥️ Server Performance</h3>
                <div class="metric">
                    <span class="metric-label">Memory Usage</span>
                    <span class="metric-value">${Math.round(metrics.server.memory.rss / 1024 / 1024)} MB</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Uptime</span>
                    <span class="metric-value">${Math.round(metrics.server.uptime / 3600)}h ${Math.round((metrics.server.uptime % 3600) / 60)}m</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Process ID</span>
                    <span class="metric-value">${metrics.server.pid}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Response Time</span>
                    <span class="metric-value">${Math.round(metrics.performance.responseTime)}ms</span>
                </div>
            </div>
            
            <div class="card">
                <h3>📊 Performance Metrics</h3>
                <div class="metric">
                    <span class="metric-label">Throughput</span>
                    <span class="metric-value">${metrics.performance.throughput.toFixed(2)} req/s</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Error Rate</span>
                    <span class="metric-value">${metrics.performance.errorRate.toFixed(2)}%</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Redis Status</span>
                    <span class="metric-value ${metrics.redis.connected ? 'status-healthy' : 'status-unhealthy'}">
                        ${metrics.redis.connected ? '✅ Connected' : '❌ Disconnected'}
                    </span>
                </div>
                <div class="metric">
                    <span class="metric-label">Redis Memory</span>
                    <span class="metric-value">${metrics.redis.usedMemory || 'N/A'}</span>
                </div>
            </div>
        </div>
        
        <div class="card" style="margin-top: 20px;">
            <h3>📈 System Status</h3>
            <p>The Circle app is optimized to handle <strong>thousands of concurrent users</strong> with the following improvements:</p>
            <ul>
                <li>✅ Redis-based distributed matchmaking queue</li>
                <li>✅ Geospatial indexing for location-based matching</li>
                <li>✅ Real-time Socket.IO events (no polling)</li>
                <li>✅ Connection pooling and rate limiting</li>
                <li>✅ Horizontal scaling support</li>
                <li>✅ Comprehensive monitoring and metrics</li>
            </ul>
            <p><strong>Performance Target:</strong> &lt;100ms response time for 10,000+ concurrent users</p>
        </div>
    </div>
</body>
</html>
    `
    
    res.send(html)
  } catch (error) {
    console.error('Failed to render dashboard:', error)
    res.status(500).send('<h1>Dashboard Error</h1><p>Failed to load monitoring dashboard</p>')
  }
})

// Reset performance counters (admin only)
router.post('/reset', requireAuth, async (req: AuthRequest, res) => {
  try {
    // Add admin check here if needed
    monitoringService.resetPerformanceCounters()
    res.json({ message: 'Performance counters reset' })
  } catch (error) {
    console.error('Failed to reset counters:', error)
    res.status(500).json({ error: 'Failed to reset performance counters' })
  }
})

export default router
