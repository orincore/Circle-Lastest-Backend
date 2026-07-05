import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'

// If you re-run `drizzle-kit pull`, it OVERWRITES `src/server/db/schema.ts` and
// will silently drop a hand-added stub: `pgSchema("auth")` + `usersInAuth` table,
// needed because `explore_interactions` has FKs into Supabase's `auth.users`,
// which `pull` cannot see (it only introspects `public`). Without that stub,
// `relations.ts` (which imports `usersInAuth`) throws
// `ReferenceError: usersInAuth is not defined` the moment `drizzle(pool, { schema })`
// builds its relational config. After any re-pull: re-add the stub (see the
// comment block this originally landed in, in schema.ts, for the exact code) and
// re-check that `explore_interactions` still has 0 rows on the Supabase source —
// the empty `auth.users` stub only works because that table has nothing to
// violate the FK against.
//
// `drizzle-kit pull` also regenerates `src/server/db/relations.ts` with a bare
// `from "./schema"` import, which fails this project's TypeScript config
// ("module"/"moduleResolution": "NodeNext" requires explicit `.js` extensions
// on relative imports). After any re-pull, fix that one import line back to
// `from "./schema.js"` and re-run `npx tsc --noEmit` to confirm.
export default defineConfig({
  dialect: 'postgresql',
  out: './src/server/db',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
