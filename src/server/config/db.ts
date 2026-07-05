import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { env } from './env.js'
import * as schema from '../db/schema.js'
import * as relations from '../db/relations.js'

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
})

// Relations must be part of the schema object for `db.query.<table>.findMany({ with: ... })`
// relational queries to work (drizzle resolves `with` against the declared relations).
export const db = drizzle(pool, { schema: { ...schema, ...relations } })
