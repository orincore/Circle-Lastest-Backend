import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin, AdminRequest } from '../middleware/adminAuth.js'
import { dockerMonitoringService } from '../services/docker-monitoring.service.js'

const router = Router()

/**
 * Get full monitoring data (overview, server, containers, deployment status)
 * GET /api/admin/docker/monitoring
 */
router.get('/monitoring', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const data = await dockerMonitoringService.getFullMonitoringData()
    res.json({ success: true, data })
  } catch (error: any) {
    console.error('Failed to get monitoring data:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get monitoring data',
      message: error.message 
    })
  }
})

/**
 * Get Docker overview
 * GET /api/admin/docker/overview
 */
router.get('/overview', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const overview = await dockerMonitoringService.getDockerOverview()
    res.json({ success: true, data: overview })
  } catch (error: any) {
    console.error('Failed to get Docker overview:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get Docker overview',
      message: error.message 
    })
  }
})

/**
 * Get server stats
 * GET /api/admin/docker/server
 */
router.get('/server', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const server = await dockerMonitoringService.getServerStats()
    res.json({ success: true, data: server })
  } catch (error: any) {
    console.error('Failed to get server stats:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get server stats',
      message: error.message 
    })
  }
})

/**
 * Get all containers with stats
 * GET /api/admin/docker/containers
 */
router.get('/containers', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const containers = await dockerMonitoringService.getContainers()
    res.json({ success: true, data: containers })
  } catch (error: any) {
    console.error('Failed to get containers:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get containers',
      message: error.message 
    })
  }
})

/**
 * Get deployment status (blue/green)
 * GET /api/admin/docker/deployment
 */
router.get('/deployment', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const deployment = await dockerMonitoringService.getDeploymentStatus()
    res.json({ success: true, data: deployment })
  } catch (error: any) {
    console.error('Failed to get deployment status:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get deployment status',
      message: error.message 
    })
  }
})

/**
 * Get container logs
 * GET /api/admin/docker/containers/:containerId/logs
 */
router.get('/containers/:containerId/logs', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { containerId } = req.params
    const lines = parseInt(req.query.lines as string) || 100
    const logs = await dockerMonitoringService.getContainerLogs(containerId, lines)
    res.json({ success: true, data: logs })
  } catch (error: any) {
    console.error('Failed to get container logs:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get container logs',
      message: error.message 
    })
  }
})

/**
 * Get recent Docker events
 * GET /api/admin/docker/events
 */
router.get('/events', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const since = (req.query.since as string) || '5m'
    const events = await dockerMonitoringService.getRecentEvents(since)
    res.json({ success: true, data: events })
  } catch (error: any) {
    console.error('Failed to get Docker events:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get Docker events',
      message: error.message 
    })
  }
})

/**
 * Restart a container
 * POST /api/admin/docker/containers/:containerId/restart
 */
router.post('/containers/:containerId/restart', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { containerId } = req.params
    const result = await dockerMonitoringService.restartContainer(containerId)
    
    if (result.success) {
      res.json({ success: true, message: result.message })
    } else {
      res.status(500).json({ success: false, error: result.message })
    }
  } catch (error: any) {
    console.error('Failed to restart container:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to restart container',
      message: error.message 
    })
  }
})

/**
 * Stop a container
 * POST /api/admin/docker/containers/:containerId/stop
 */
router.post('/containers/:containerId/stop', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { containerId } = req.params
    const result = await dockerMonitoringService.stopContainer(containerId)
    
    if (result.success) {
      res.json({ success: true, message: result.message })
    } else {
      res.status(500).json({ success: false, error: result.message })
    }
  } catch (error: any) {
    console.error('Failed to stop container:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to stop container',
      message: error.message 
    })
  }
})

/**
 * Start a container
 * POST /api/admin/docker/containers/:containerId/start
 */
router.post('/containers/:containerId/start', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { containerId } = req.params
    const result = await dockerMonitoringService.startContainer(containerId)
    
    if (result.success) {
      res.json({ success: true, message: result.message })
    } else {
      res.status(500).json({ success: false, error: result.message })
    }
  } catch (error: any) {
    console.error('Failed to start container:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Failed to start container',
      message: error.message 
    })
  }
})

export default router
