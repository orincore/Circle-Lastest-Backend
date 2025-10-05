import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import { typeDefs } from './schema.js'
import { resolvers } from './resolvers.js'
import express, { type Express } from 'express'
import { verifyJwt } from '../utils/jwt.js'

export async function setupGraphQL(app: Express) {
  try {
    const server = new ApolloServer({ typeDefs, resolvers })
    await server.start()

    app.use('/graphql', express.json(), expressMiddleware(server, {
      context: async ({ req }) => {
        const header = req.headers.authorization || ''
        const token = header.startsWith('Bearer ') ? header.slice(7) : undefined
        if (!token) return { user: null }
        
        try {
          const payload = verifyJwt<{ sub: string; email: string; username: string }>(token)
          const user = payload ? { id: payload.sub, email: payload.email, username: payload.username } : null
          return { user }
        } catch (error) {
          return { user: null }
        }
      }
    }))
  } catch (error) {
    console.error('Failed to setup GraphQL:', error)
    throw error
  }
}
