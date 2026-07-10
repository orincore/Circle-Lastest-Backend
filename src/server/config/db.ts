import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { env } from './env.js'
import { logger } from './logger.js'
import * as schema from '../db/schema.js'
import * as relations from '../db/relations.js'

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
})

// node-postgres's Pool is an EventEmitter that emits 'error' whenever an
// *idle* client in the pool hits a network-level error (a Postgres restart,
// connection reset, brief network blip) -- routine, recoverable events the
// pool itself already handles by discarding that client. But an EventEmitter
// with zero 'error' listeners throws synchronously on emit, and with no
// process-level uncaughtException handler either, that throw was crashing
// the entire Node process -- taking every live WebSocket connection down
// with it. This is the single highest-confidence root cause behind "chat
// system went down": every pod shares one Postgres instance, so a single
// Postgres blip could crash them all at once.
pool.on('error', (err) => {
  logger.error({ err }, 'Postgres pool idle client error (recovered, pool continues)')
})

// Relations must be part of the schema object for `db.query.<table>.findMany({ with: ... })`
// relational queries to work (drizzle resolves `with` against the declared relations).
export const db = drizzle(pool, { schema: { ...schema, ...relations } })
