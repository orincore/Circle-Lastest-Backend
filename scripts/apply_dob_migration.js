#!/usr/bin/env node

/**
 * Applies migrations/add_date_of_birth_to_profiles.sql directly against
 * DATABASE_URL via a real Postgres connection (same driver config.db.ts
 * uses), instead of the Supabase RPC-hack pattern in scripts/run_migration.js.
 */

import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const migrationPath = join(__dirname, '../migrations/add_date_of_birth_to_profiles.sql')
  const sql = readFileSync(migrationPath, 'utf8')

  try {
    console.log('Applying add_date_of_birth_to_profiles.sql...')
    await pool.query(sql)
    console.log('Migration applied successfully.')

    const check = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'profiles' AND column_name = 'date_of_birth'`
    )
    console.log('Column check:', check.rows)

    const fnCheck = await pool.query(`SELECT calculate_age('2000-01-01'::date) AS age`)
    console.log('calculate_age() sanity check (dob=2000-01-01):', fnCheck.rows[0])
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
