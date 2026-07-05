import { pool } from '../../src/server/config/db.js'

const result = await pool.query('select 1 as ok')
console.log('DB connection OK:', result.rows[0])
await pool.end()
