import { logger } from '../config/logger.js'
import { getConnectionMetrics } from '../sockets/optimized-socket.js'
import { getMetrics as getMatchmakingMetrics } from './matchmaking-optimized.js'
import { Redis } from 'ioredis'

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

interface SystemMetrics {
  timestamp: number
  server: {
    uptime: number
    memory: NodeJS.MemoryUsage
    cpu: number
    pid: number
  }
  connections: {
    total: number
    uniqueUsers: number
    averagePerUser: number
  }
  matchmaking: {
    searchesStarted: number
    searchesCancelled: number
    proposalsCreated: number
    matchesCreated: number
    currentSearching: number
    activeProposals: number
  }
  redis: {
    connected: boolean
    usedMemory?: string
    connectedClients?: number
  }
  performance: {
    responseTime: number
    errorRate: number
    throughput: number
  }
}

class MonitoringService {
  private metrics: SystemMetrics[] = []
  private readonly maxMetricsHistory = 1000
  private performanceData = {
    requests: 0,
    errors: 0,
    totalResponseTime: 0,
    startTime: Date.now()
  }

  // Track request performance
  recordRequest(responseTime: number, isError: boolean = false) {
    this.performanceData.requests++
    this.performanceData.totalResponseTime += responseTime
    if (isError) {
      this.performanceData.errors++
    }
  }

  // Get CPU usage (simplified)
  private getCpuUsage(): number {
    const usage = process.cpuUsage()
    return (usage.user + usage.system) / 1000000 // Convert to seconds
  }

  // Get Redis info
  private async getRedisInfo(): Promise<{ connected: boolean; usedMemory?: string; connectedClients?: number }> {
    try {
      if (redis.status !== 'ready') {
        return { connected: false }
      }

      const info = await redis.info('memory')
      const clients = await redis.info('clients')
      
      const usedMemoryMatch = info.match(/used_memory_human:(.+)/)
      const connectedClientsMatch = clients.match(/connected_clients:(\d+)/)
      
      return {
        connected: true,
        usedMemory: usedMemoryMatch ? usedMemoryMatch[1].trim() : undefined,
        connectedClients: connectedClientsMatch ? parseInt(connectedClientsMatch[1]) : undefined
      }
    } catch (error) {
      logger.error({ error }, 'Failed to get Redis info')
      return { connected: false }
    }
  }

  // Collect system metrics
  async collectMetrics(): Promise<SystemMetrics> {
    try {
      const connectionMetrics = getConnectionMetrics()
      const matchmakingMetrics = await getMatchmakingMetrics()
      const redisInfo = await this.getRedisInfo()
      
      const uptime = process.uptime()
      const timeSinceStart = (Date.now() - this.performanceData.startTime) / 1000
      
      const metrics: SystemMetrics = {
        timestamp: Date.now(),
        server: {
          uptime,
          memory: process.memoryUsage(),
          cpu: this.getCpuUsage(),
          pid: process.pid
        },
        connections: {
          total: connectionMetrics.totalConnections,
          uniqueUsers: connectionMetrics.uniqueUsers,
          averagePerUser: connectionMetrics.averageConnectionsPerUser
        },
        matchmaking: {
          searchesStarted: matchmakingMetrics.searches_started || 0,
          searchesCancelled: matchmakingMetrics.searches_cancelled || 0,
          proposalsCreated: matchmakingMetrics.proposals_created || 0,
          matchesCreated: matchmakingMetrics.matches_created || 0,
          currentSearching: matchmakingMetrics.current_searching || 0,
          activeProposals: matchmakingMetrics.active_proposals || 0
        },
        redis: redisInfo,
        performance: {
          responseTime: this.performanceData.requests > 0 
            ? this.performanceData.totalResponseTime / this.performanceData.requests 
            : 0,
          errorRate: this.performanceData.requests > 0 
            ? (this.performanceData.errors / this.performanceData.requests) * 100 
            : 0,
          throughput: timeSinceStart > 0 ? this.performanceData.requests / timeSinceStart : 0
        }
      }

      // Store metrics in memory (limited history)
      this.metrics.push(metrics)
      if (this.metrics.length > this.maxMetricsHistory) {
        this.metrics.shift()
      }

      // Store in Redis for persistence and sharing across instances
      try {
        await redis.setex(
          `metrics:${process.pid}:${Date.now()}`,
          300, // 5 minutes TTL
          JSON.stringify(metrics)
        )
      } catch (error) {
        logger.error({ error }, 'Failed to store metrics in Redis')
      }

      return metrics
    } catch (error) {
      logger.error({ error }, 'Failed to collect metrics')
      throw error
    }
  }

  // Get recent metrics
  getRecentMetrics(count: number = 10): SystemMetrics[] {
    return this.metrics.slice(-count)
  }

  // Get aggregated metrics from all instances
  async getAggregatedMetrics(): Promise<{
    instances: SystemMetrics[]
    totals: {
      connections: number
      uniqueUsers: number
      currentSearching: number
      activeProposals: number
      totalMemoryMB: number
    }
  }> {
    try {
      // Get metrics from all instances in the last 5 minutes
      const keys = await redis.keys('metrics:*')
      const recentKeys = keys.filter((key: string) => {
        const timestamp = parseInt(key.split(':')[2])
        return Date.now() - timestamp < 300000 // 5 minutes
      })

      const metricsData = await Promise.all(
        recentKeys.map(async (key: string) => {
          try {
            const data = await redis.get(key)
            return data ? JSON.parse(data) as SystemMetrics : null
          } catch {
            return null
          }
        })
      )

      const instances = metricsData.filter(Boolean) as SystemMetrics[]
      
      // Calculate totals
      const totals = instances.reduce(
        (acc, metrics) => ({
          connections: acc.connections + metrics.connections.total,
          uniqueUsers: acc.uniqueUsers + metrics.connections.uniqueUsers,
          currentSearching: acc.currentSearching + metrics.matchmaking.currentSearching,
          activeProposals: acc.activeProposals + metrics.matchmaking.activeProposals,
          totalMemoryMB: acc.totalMemoryMB + (metrics.server.memory.rss / 1024 / 1024)
        }),
        { connections: 0, uniqueUsers: 0, currentSearching: 0, activeProposals: 0, totalMemoryMB: 0 }
      )

      return { instances, totals }
    } catch (error) {
      logger.error({ error }, 'Failed to get aggregated metrics')
      return { instances: [], totals: { connections: 0, uniqueUsers: 0, currentSearching: 0, activeProposals: 0, totalMemoryMB: 0 } }
    }
  }

  // Health check
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    checks: Record<string, { status: 'pass' | 'fail'; message?: string }>
  }> {
    const checks: Record<string, { status: 'pass' | 'fail'; message?: string }> = {}

    // Memory check
    const memory = process.memoryUsage()
    const memoryUsageMB = memory.rss / 1024 / 1024
    checks.memory = {
      status: memoryUsageMB < 1000 ? 'pass' : 'fail', // 1GB limit
      message: `${memoryUsageMB.toFixed(2)}MB used`
    }

    // Redis check
    try {
      await redis.ping()
      checks.redis = { status: 'pass' }
    } catch (error) {
      checks.redis = { status: 'fail', message: 'Redis connection failed' }
    }

    // Error rate check
    const errorRate = this.performanceData.requests > 0 
      ? (this.performanceData.errors / this.performanceData.requests) * 100 
      : 0
    checks.errorRate = {
      status: errorRate < 5 ? 'pass' : 'fail', // 5% error rate threshold
      message: `${errorRate.toFixed(2)}% error rate`
    }

    // Response time check
    const avgResponseTime = this.performanceData.requests > 0 
      ? this.performanceData.totalResponseTime / this.performanceData.requests 
      : 0
    checks.responseTime = {
      status: avgResponseTime < 1000 ? 'pass' : 'fail', // 1 second threshold
      message: `${avgResponseTime.toFixed(2)}ms average`
    }

    // Determine overall status
    const failedChecks = Object.values(checks).filter(check => check.status === 'fail').length
    let status: 'healthy' | 'degraded' | 'unhealthy'
    
    if (failedChecks === 0) {
      status = 'healthy'
    } else if (failedChecks <= 1) {
      status = 'degraded'
    } else {
      status = 'unhealthy'
    }

    return { status, checks }
  }

  // Reset performance counters
  resetPerformanceCounters() {
    this.performanceData = {
      requests: 0,
      errors: 0,
      totalResponseTime: 0,
      startTime: Date.now()
    }
  }

  // Start monitoring interval
  startMonitoring(intervalMs: number = 30000) {
    setInterval(async () => {
      try {
        const metrics = await this.collectMetrics()
        
        // Only log metrics if there are issues or significant changes
        const memoryMB = Math.round(metrics.server.memory.rss / 1024 / 1024)
        const errorRate = Math.round(metrics.performance.errorRate * 100) / 100
        
        // Log only if memory > 500MB, error rate > 1%, or high connections
        if (memoryMB > 500 || errorRate > 1 || metrics.connections.total > 100) {
          logger.info({
            connections: metrics.connections.total,
            uniqueUsers: metrics.connections.uniqueUsers,
            searching: metrics.matchmaking.currentSearching,
            memoryMB,
            responseTime: Math.round(metrics.performance.responseTime),
            errorRate
          }, 'System metrics - attention needed')
        }

        // Alert on high error rates
        if (metrics.performance.errorRate > 10) {
          logger.error({
            errorRate: metrics.performance.errorRate,
            requests: this.performanceData.requests,
            errors: this.performanceData.errors
          }, 'High error rate detected')
        }

        // Alert on high memory usage (reuse memoryMB from above)
        if (memoryMB > 1500) {
          logger.warn({
            memoryMB,
            heapUsed: Math.round(metrics.server.memory.heapUsed / 1024 / 1024)
          }, 'High memory usage detected')
        }

      } catch (error) {
        logger.error({ error }, 'Failed to collect monitoring metrics')
      }
    }, intervalMs)
  }
}

export const monitoringService = new MonitoringService()

// Express middleware for performance tracking
export function performanceMiddleware() {
  return (req: any, res: any, next: any) => {
    const startTime = Date.now()
    
    res.on('finish', () => {
      const responseTime = Date.now() - startTime
      const isError = res.statusCode >= 400
      monitoringService.recordRequest(responseTime, isError)
    })
    
    next()
  }
}
