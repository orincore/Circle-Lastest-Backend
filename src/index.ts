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
  await initOptimizedSocket(server)

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
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to start server')
  process.exit(1)
})
