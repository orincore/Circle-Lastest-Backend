import http from 'http'
import { initOptimizedSocket } from './server/sockets/optimized-socket.js'
import { env } from './server/config/env.js'
import { logger } from './server/config/logger.js'
import { prepareApp } from './server/bootstrap.js'

// Node (v15+) already terminates the process on an unhandled rejection by
// default, and always has for uncaught exceptions -- these handlers don't
// change that, they just log a diagnosable line first instead of losing the
// error to a raw crash dump. Same pattern as matchmaking-worker.ts. Exiting
// (rather than trying to "continue" in a possibly-corrupted state) is
// intentional: this process runs behind multiple replicas, so letting the
// orchestrator restart a fresh one is the safe default.
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception - process exiting')
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection - process exiting')
  process.exit(1)
})

async function bootstrap() {
  const app = await prepareApp()
  const server = http.createServer(app)

  // Initialize Socket.IO with Redis adapter (async for proper Redis connection)
  const io = await initOptimizedSocket(server)

  server.listen(env.PORT, () => {
    console.log('\n')
    console.log('╔════════════════════════════════════════════════╗')
    console.log('║           Circle Backend Started               ║')
    console.log('╚════════════════════════════════════════════════╝')
    console.log(`\n🚀 Server running on port ${env.PORT}`)
    console.log(`🌍 Environment: ${env.NODE_ENV}`)
    console.log(`📡 WebSocket: ws://localhost:${env.PORT}/ws`)
    console.log(`🔗 GraphQL: http://localhost:${env.PORT}/graphql`)
    console.log(`💚 Health: http://localhost:${env.PORT}/health\n`)

    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server started')
  })

  // Graceful shutdown: k8s sends SIGTERM on every rolling deploy, scale-down,
  // or node drain -- the deployment manifests (k8s/base/{api,socket}-
  // deployment.yaml) already budget time for this via preStop + a
  // terminationGracePeriodSeconds window (their own comments note the app
  // "doesn't drain on signal"), but with no handler at all Node's default
  // action hard-kills the process the instant the signal arrives, dropping
  // every live WebSocket with zero notice. io.close() disconnects every
  // socket on this pod (clients' own reconnect logic then lands on a
  // healthy pod) and closes the underlying HTTP server; the fallback timer
  // force-exits well within the shortest grace-period budget (socket pods:
  // 20s total, 10s already spent in preStop) in case some connection hangs
  // past that instead of closing promptly.
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Received shutdown signal, draining connections')

    const forceExit = setTimeout(() => {
      logger.warn('Shutdown grace period elapsed, forcing exit')
      process.exit(0)
    }, 8000)
    forceExit.unref()

    io.close(() => {
      logger.info('Server closed cleanly')
      clearTimeout(forceExit)
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to start server')
  process.exit(1)
})
