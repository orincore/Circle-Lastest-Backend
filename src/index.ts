import http from 'http'
import { initOptimizedSocket } from './server/sockets/optimized-socket.js'
import { env } from './server/config/env.js'
import { logger } from './server/config/logger.js'
import { prepareApp } from './server/bootstrap.js'

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
