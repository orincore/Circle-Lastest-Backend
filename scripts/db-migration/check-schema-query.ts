import { db, pool } from '../../src/server/config/db.js'
import { profiles } from '../../src/server/db/schema.js'

const rows = await db.select().from(profiles).limit(1)
console.log(`Fetched ${rows.length} row(s) from profiles via Drizzle:`, rows[0] ?? '(table is empty)')
await pool.end()
