import { Pool } from 'pg'
import 'dotenv/config'

const supabasePool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL })
const localPool = new Pool({ connectionString: process.env.DATABASE_URL })

async function getTableNames(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  )
  return rows.map((r) => r.tablename)
}

async function getRowCount(pool: Pool, table: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}"`)
  return Number(rows[0].count)
}

async function main() {
  const supabaseTables = await getTableNames(supabasePool)
  const localTables = await getTableNames(localPool)

  const allTables = Array.from(new Set([...supabaseTables, ...localTables])).sort()
  let mismatches = 0

  for (const table of allTables) {
    const inSupabase = supabaseTables.includes(table)
    const inLocal = localTables.includes(table)

    if (!inSupabase || !inLocal) {
      console.log(`MISMATCH  ${table}: supabase=${inSupabase ? 'present' : 'MISSING'} local=${inLocal ? 'present' : 'MISSING'}`)
      mismatches++
      continue
    }

    const [supabaseCount, localCount] = await Promise.all([
      getRowCount(supabasePool, table),
      getRowCount(localPool, table),
    ])

    if (supabaseCount !== localCount) {
      console.log(`MISMATCH  ${table}: supabase=${supabaseCount} local=${localCount}`)
      mismatches++
    } else {
      console.log(`OK        ${table}: ${supabaseCount} rows`)
    }
  }

  await supabasePool.end()
  await localPool.end()

  if (mismatches > 0) {
    console.error(`\n${mismatches} table(s) mismatched.`)
    process.exit(1)
  }
  console.log(`\nAll ${allTables.length} tables match.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
