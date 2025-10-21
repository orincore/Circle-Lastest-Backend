import http from 'http'
import { app } from './server/app.js'
import { initOptimizedSocket } from './server/sockets/optimized-socket.js'
import { env } from './server/config/env.js'
import { logger } from './server/config/logger.js'
import { setupGraphQL } from './server/graphql/index.js'
import { notFound, errorHandler } from './server/middleware/errorHandler.js'
import { loadActivitiesFromDatabase } from './server/services/activityService.js'

async function bootstrap() {
  await setupGraphQL(app)

  // Load existing activities from database
  await loadActivitiesFromDatabase()

  // Register 404 and error handlers AFTER GraphQL and routes
  app.use(notFound)
  app.use(errorHandler)

  const server = http.createServer(app)
  initOptimizedSocket(server)

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
