#!/usr/bin/env node
// Tracked SQL migration runner.
//
// Historically, migrations under /migrations were applied ad hoc with no
// tracking table, so production's schema reflects an unknown subset of these
// files. Before wiring this into CI, run once with --baseline against the
// PRODUCTION database to record every currently-present file as already
// applied WITHOUT executing it. From then on, `npm run migrate` only runs
// files that are new since the baseline.
//
// New migrations must be added as new files (never edit an applied one --
// the checksum check below will refuse to proceed if it detects that).
// Name new files with a numeric prefix (e.g. 077_add_x.sql) so ordering
// stays predictable; older files were not all prefixed and are only ever
// baselined, never re-run, so their order doesn't matter retroactively.
import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import pg from 'pg'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations')
const BASELINE = process.argv.includes('--baseline')

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function loadMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename,
      content: readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'),
    }))
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const files = loadMigrationFiles()
    const { rows: applied } = await client.query('SELECT filename, checksum FROM schema_migrations')
    const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]))

    let ran = 0
    for (const { filename, content } of files) {
      const checksum = sha256(content)
      const previousChecksum = appliedMap.get(filename)

      if (previousChecksum) {
        if (previousChecksum !== checksum) {
          throw new Error(
            `Checksum mismatch for already-applied migration "${filename}". ` +
              `It was edited after being applied — never edit an applied migration, add a new file instead.`
          )
        }
        continue
      }

      if (BASELINE) {
        console.log(`[baseline] recording ${filename} as already applied (not executing)`)
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ])
        ran++
        continue
      }

      console.log(`[migrate] applying ${filename}`)
      await client.query('BEGIN')
      try {
        await client.query(content)
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ])
        await client.query('COMMIT')
        ran++
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration "${filename}" failed, rolled back: ${err.message}`)
      }
    }

    console.log(
      ran === 0
        ? 'Nothing to do — schema is up to date.'
        : `${BASELINE ? 'Baselined' : 'Applied'} ${ran} file(s).`
    )
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
