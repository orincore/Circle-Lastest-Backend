import { logger } from '../config/logger.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface ContainerStats {
  id: string
  name: string
  status: 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | 'created' | 'unknown'
  health: 'healthy' | 'unhealthy' | 'starting' | 'none'
  image: string
  created: string
  uptime: string
  cpu: {
    percent: number
    cores: number
  }
  memory: {
    used: number
    limit: number
    percent: number
    usedFormatted: string
    limitFormatted: string
  }
  network: {
    rxBytes: number
    txBytes: number
    rxFormatted: string
    txFormatted: string
  }
  blockIO: {
    read: number
    write: number
    readFormatted: string
    writeFormatted: string
  }
  pids: number
  restartCount: number
  deploymentColor?: 'blue' | 'green'
  serviceType?: string
  ports: string[]
}

export interface ServerStats {
  hostname: string
  platform: string
  arch: string
  cpuCount: number
  totalMemory: number
  freeMemory: number
  memoryUsedPercent: number
  loadAverage: number[]
  uptime: number
  diskUsage: {
    total: number
    used: number
    available: number
    percent: number
  }
}

export interface DockerOverview {
  totalContainers: number
  runningContainers: number
  pausedContainers: number
  stoppedContainers: number
  totalImages: number
  dockerVersion: string
  serverTime: string
}

export interface ContainerLogs {
  containerId: string
  containerName: string
  logs: string[]
  timestamp: string
}

class DockerMonitoringService {
  private containerStatsCache: Map<string, ContainerStats> = new Map()
  private lastUpdateTime: number = 0
  private readonly cacheTimeout = 5000 // 5 seconds

  // Format bytes to human readable
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  // Parse docker stats output
  private parseDockerStats(statsOutput: string): Partial<ContainerStats>[] {
    const lines = statsOutput.trim().split('\n').filter(line => line.trim())
    if (lines.length === 0) return []

    return lines.map(line => {
      try {
        const parts = line.split(/\s{2,}/).map(p => p.trim())
        if (parts.length < 7) return null

        const [containerId, name, cpuStr, memStr, netStr, blockStr, pidsStr] = parts

        // Parse CPU
        const cpuPercent = parseFloat(cpuStr.replace('%', '')) || 0

        // Parse Memory (e.g., "100MiB / 768MiB")
        const memMatch = memStr.match(/(\d+\.?\d*)\s*(\w+)\s*\/\s*(\d+\.?\d*)\s*(\w+)/)
        let memUsed = 0, memLimit = 0
        if (memMatch) {
          memUsed = this.parseMemoryValue(parseFloat(memMatch[1]), memMatch[2])
          memLimit = this.parseMemoryValue(parseFloat(memMatch[3]), memMatch[4])
        }

        // Parse Network (e.g., "1.5kB / 0B")
        const netMatch = netStr.match(/(\d+\.?\d*)\s*(\w+)\s*\/\s*(\d+\.?\d*)\s*(\w+)/)
        let rxBytes = 0, txBytes = 0
        if (netMatch) {
          rxBytes = this.parseMemoryValue(parseFloat(netMatch[1]), netMatch[2])
          txBytes = this.parseMemoryValue(parseFloat(netMatch[3]), netMatch[4])
        }

        // Parse Block I/O
        const blockMatch = blockStr.match(/(\d+\.?\d*)\s*(\w+)\s*\/\s*(\d+\.?\d*)\s*(\w+)/)
        let blockRead = 0, blockWrite = 0
        if (blockMatch) {
          blockRead = this.parseMemoryValue(parseFloat(blockMatch[1]), blockMatch[2])
          blockWrite = this.parseMemoryValue(parseFloat(blockMatch[3]), blockMatch[4])
        }

        // Parse PIDs
        const pids = parseInt(pidsStr) || 0

        return {
          id: containerId,
          name,
          cpu: { percent: cpuPercent, cores: 0 },
          memory: {
            used: memUsed,
            limit: memLimit,
            percent: memLimit > 0 ? (memUsed / memLimit) * 100 : 0,
            usedFormatted: this.formatBytes(memUsed),
            limitFormatted: this.formatBytes(memLimit)
          },
          network: {
            rxBytes,
            txBytes,
            rxFormatted: this.formatBytes(rxBytes),
            txFormatted: this.formatBytes(txBytes)
          },
          blockIO: {
            read: blockRead,
            write: blockWrite,
            readFormatted: this.formatBytes(blockRead),
            writeFormatted: this.formatBytes(blockWrite)
          },
          pids
        }
      } catch (error) {
        logger.error({ error, line }, 'Failed to parse docker stats line')
        return null
      }
    }).filter(Boolean) as Partial<ContainerStats>[]
  }

  private parseMemoryValue(value: number, unit: string): number {
    const unitLower = unit.toLowerCase()
    if (unitLower.includes('gib') || unitLower.includes('gb')) return value * 1024 * 1024 * 1024
    if (unitLower.includes('mib') || unitLower.includes('mb')) return value * 1024 * 1024
    if (unitLower.includes('kib') || unitLower.includes('kb')) return value * 1024
    return value
  }

  // Get all containers with their status
  async getContainers(): Promise<ContainerStats[]> {
    try {
      // Get container list with details
      const { stdout: psOutput } = await execAsync(
        'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.CreatedAt}}|{{.Ports}}"'
      )

      const containers: ContainerStats[] = []
      const lines = psOutput.trim().split('\n').filter(line => line.trim())

      for (const line of lines) {
        const [id, name, statusStr, image, created, ports] = line.split('|')
        
        // Parse status
        let status: ContainerStats['status'] = 'unknown'
        let health: ContainerStats['health'] = 'none'
        let uptime = ''

        if (statusStr.toLowerCase().includes('up')) {
          status = 'running'
          const uptimeMatch = statusStr.match(/Up\s+(.+?)(?:\s+\(|$)/i)
          uptime = uptimeMatch ? uptimeMatch[1].trim() : ''
          
          if (statusStr.includes('(healthy)')) health = 'healthy'
          else if (statusStr.includes('(unhealthy)')) health = 'unhealthy'
          else if (statusStr.includes('(health: starting)')) health = 'starting'
        } else if (statusStr.toLowerCase().includes('exited')) {
          status = 'exited'
        } else if (statusStr.toLowerCase().includes('paused')) {
          status = 'paused'
        } else if (statusStr.toLowerCase().includes('restarting')) {
          status = 'restarting'
        } else if (statusStr.toLowerCase().includes('dead')) {
          status = 'dead'
        } else if (statusStr.toLowerCase().includes('created')) {
          status = 'created'
        }

        // Determine deployment color and service type from name
        let deploymentColor: 'blue' | 'green' | undefined
        let serviceType: string | undefined

        if (name.includes('-blue')) deploymentColor = 'blue'
        else if (name.includes('-green')) deploymentColor = 'green'

        if (name.includes('api')) serviceType = 'api'
        else if (name.includes('socket')) serviceType = 'socket'
        else if (name.includes('matchmaking')) serviceType = 'matchmaking'
        else if (name.includes('redis')) serviceType = 'redis'
        else if (name.includes('nginx')) serviceType = 'nginx'
        else if (name.includes('cron')) serviceType = 'cron'

        // Get restart count
        let restartCount = 0
        try {
          const { stdout: inspectOutput } = await execAsync(
            `docker inspect --format '{{.RestartCount}}' ${id}`
          )
          restartCount = parseInt(inspectOutput.trim()) || 0
        } catch (e) {
          // Ignore
        }

        containers.push({
          id: id.substring(0, 12),
          name,
          status,
          health,
          image,
          created,
          uptime,
          cpu: { percent: 0, cores: 0 },
          memory: {
            used: 0,
            limit: 0,
            percent: 0,
            usedFormatted: '0 B',
            limitFormatted: '0 B'
          },
          network: {
            rxBytes: 0,
            txBytes: 0,
            rxFormatted: '0 B',
            txFormatted: '0 B'
          },
          blockIO: {
            read: 0,
            write: 0,
            readFormatted: '0 B',
            writeFormatted: '0 B'
          },
          pids: 0,
          restartCount,
          deploymentColor,
          serviceType,
          ports: ports ? ports.split(',').map(p => p.trim()) : []
        })
      }

      // Get live stats for running containers
      const runningIds = containers.filter(c => c.status === 'running').map(c => c.id)
      if (runningIds.length > 0) {
        try {
          const { stdout: statsOutput } = await execAsync(
            `docker stats --no-stream --format "{{.ID}}  {{.Name}}  {{.CPUPerc}}  {{.MemUsage}}  {{.NetIO}}  {{.BlockIO}}  {{.PIDs}}" ${runningIds.join(' ')}`
          )
          
          const statsData = this.parseDockerStats(statsOutput)
          
          for (const stat of statsData) {
            const container = containers.find(c => c.id === stat.id || c.name === stat.name)
            if (container && stat) {
              container.cpu = stat.cpu || container.cpu
              container.memory = stat.memory || container.memory
              container.network = stat.network || container.network
              container.blockIO = stat.blockIO || container.blockIO
              container.pids = stat.pids || container.pids
            }
          }
        } catch (error) {
          logger.error({ error }, 'Failed to get docker stats')
        }
      }

      return containers
    } catch (error) {
      // If docker CLI is not available inside the container, return empty list instead of throwing
      const message = (error as any)?.stderr || (error as any)?.message || ''
      if (typeof message === 'string' && message.includes('docker: not found')) {
        logger.warn({ error }, 'Docker CLI not available - returning empty container list')
        return []
      }
      logger.error({ error }, 'Failed to get containers')
      throw error
    }
  }

  // Get Docker overview
  async getDockerOverview(): Promise<DockerOverview> {
    try {
      const { stdout: versionOutput } = await execAsync('docker version --format "{{.Server.Version}}"')
      const { stdout: infoOutput } = await execAsync(
        'docker info --format "{{.Containers}}|{{.ContainersRunning}}|{{.ContainersPaused}}|{{.ContainersStopped}}|{{.Images}}"'
      )

      const [total, running, paused, stopped, images] = infoOutput.trim().split('|').map(n => parseInt(n) || 0)

      return {
        totalContainers: total,
        runningContainers: running,
        pausedContainers: paused,
        stoppedContainers: stopped,
        totalImages: images,
        dockerVersion: versionOutput.trim(),
        serverTime: new Date().toISOString()
      }
    } catch (error) {
      const message = (error as any)?.stderr || (error as any)?.message || ''
      if (typeof message === 'string' && message.includes('docker: not found')) {
        logger.warn({ error }, 'Docker CLI not available - returning empty docker overview')
        return {
          totalContainers: 0,
          runningContainers: 0,
          pausedContainers: 0,
          stoppedContainers: 0,
          totalImages: 0,
          dockerVersion: 'not_available',
          serverTime: new Date().toISOString()
        }
      }
      logger.error({ error }, 'Failed to get docker overview')
      throw error
    }
  }

  // Get server stats
  async getServerStats(): Promise<ServerStats> {
    try {
      const os = await import('os')
      
      const totalMemory = os.totalmem()
      const freeMemory = os.freemem()
      const usedMemory = totalMemory - freeMemory

      // Get disk usage
      let diskUsage = { total: 0, used: 0, available: 0, percent: 0 }
      try {
        const { stdout: dfOutput } = await execAsync("df -B1 / | tail -1 | awk '{print $2,$3,$4}'")
        const [total, used, available] = dfOutput.trim().split(/\s+/).map(n => parseInt(n) || 0)
        diskUsage = {
          total,
          used,
          available,
          percent: total > 0 ? (used / total) * 100 : 0
        }
      } catch (e) {
        // Fallback for systems without df
      }

      return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpuCount: os.cpus().length,
        totalMemory,
        freeMemory,
        memoryUsedPercent: (usedMemory / totalMemory) * 100,
        loadAverage: os.loadavg(),
        uptime: os.uptime(),
        diskUsage
      }
    } catch (error) {
      logger.error({ error }, 'Failed to get server stats')
      throw error
    }
  }

  // Get container logs
  async getContainerLogs(containerId: string, lines: number = 100): Promise<ContainerLogs> {
    try {
      const { stdout: nameOutput } = await execAsync(
        `docker inspect --format '{{.Name}}' ${containerId}`
      )
      const containerName = nameOutput.trim().replace(/^\//, '')

      const { stdout: logsOutput } = await execAsync(
        `docker logs --tail ${lines} --timestamps ${containerId} 2>&1`
      )

      return {
        containerId,
        containerName,
        logs: logsOutput.split('\n').filter(line => line.trim()),
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.error({ error, containerId }, 'Failed to get container logs')
      throw error
    }
  }

  // Get container events (for real-time updates)
  async getRecentEvents(since: string = '5m'): Promise<any[]> {
    try {
      const { stdout: eventsOutput } = await execAsync(
        `docker events --since ${since} --until now --format '{{json .}}' 2>/dev/null || true`
      )

      const events = eventsOutput
        .trim()
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)

      return events
    } catch (error) {
      logger.error({ error }, 'Failed to get docker events')
      return []
    }
  }

  // Restart a container
  async restartContainer(containerId: string): Promise<{ success: boolean; message: string }> {
    try {
      await execAsync(`docker restart ${containerId}`)
      return { success: true, message: `Container ${containerId} restarted successfully` }
    } catch (error: any) {
      logger.error({ error, containerId }, 'Failed to restart container')
      return { success: false, message: error.message || 'Failed to restart container' }
    }
  }

  // Stop a container
  async stopContainer(containerId: string): Promise<{ success: boolean; message: string }> {
    try {
      await execAsync(`docker stop ${containerId}`)
      return { success: true, message: `Container ${containerId} stopped successfully` }
    } catch (error: any) {
      logger.error({ error, containerId }, 'Failed to stop container')
      return { success: false, message: error.message || 'Failed to stop container' }
    }
  }

  // Start a container
  async startContainer(containerId: string): Promise<{ success: boolean; message: string }> {
    try {
      await execAsync(`docker start ${containerId}`)
      return { success: true, message: `Container ${containerId} started successfully` }
    } catch (error: any) {
      logger.error({ error, containerId }, 'Failed to start container')
      return { success: false, message: error.message || 'Failed to start container' }
    }
  }

  // Get deployment status (blue/green)
  async getDeploymentStatus(): Promise<{
    blue: { api: string; socket: string; matchmaking: string }
    green: { api: string; socket: string; matchmaking: string }
    activeColor: 'blue' | 'green' | 'both' | 'none'
  }> {
    try {
      const containers = await this.getContainers()
      
      const getStatus = (color: string, type: string): string => {
        const container = containers.find(
          c => c.deploymentColor === color && c.serviceType === type
        )
        if (!container) return 'not_found'
        if (container.status !== 'running') return container.status
        return container.health === 'healthy' ? 'healthy' : container.health
      }

      const blue = {
        api: getStatus('blue', 'api'),
        socket: getStatus('blue', 'socket'),
        matchmaking: getStatus('blue', 'matchmaking')
      }

      const green = {
        api: getStatus('green', 'api'),
        socket: getStatus('green', 'socket'),
        matchmaking: getStatus('green', 'matchmaking')
      }

      // Determine active color
      const blueHealthy = Object.values(blue).every(s => s === 'healthy')
      const greenHealthy = Object.values(green).every(s => s === 'healthy')

      let activeColor: 'blue' | 'green' | 'both' | 'none' = 'none'
      if (blueHealthy && greenHealthy) activeColor = 'both'
      else if (blueHealthy) activeColor = 'blue'
      else if (greenHealthy) activeColor = 'green'

      return { blue, green, activeColor }
    } catch (error) {
      const message = (error as any)?.stderr || (error as any)?.message || ''
      if (typeof message === 'string' && message.includes('docker: not found')) {
        logger.warn({ error }, 'Docker CLI not available - returning unknown deployment status')
        return {
          blue: { api: 'unknown', socket: 'unknown', matchmaking: 'unknown' },
          green: { api: 'unknown', socket: 'unknown', matchmaking: 'unknown' },
          activeColor: 'none'
        }
      }
      logger.error({ error }, 'Failed to get deployment status')
      throw error
    }
  }

  // Get comprehensive monitoring data
  async getFullMonitoringData(): Promise<{
    overview: DockerOverview
    server: ServerStats
    containers: ContainerStats[]
    deployment: {
      blue: { api: string; socket: string; matchmaking: string }
      green: { api: string; socket: string; matchmaking: string }
      activeColor: 'blue' | 'green' | 'both' | 'none'
    }
    timestamp: string
  }> {
    const [overview, server, containers, deployment] = await Promise.all([
      this.getDockerOverview(),
      this.getServerStats(),
      this.getContainers(),
      this.getDeploymentStatus()
    ])

    return {
      overview,
      server,
      containers,
      deployment,
      timestamp: new Date().toISOString()
    }
  }
}

export const dockerMonitoringService = new DockerMonitoringService()
