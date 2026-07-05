import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'

export default defineConfig({
  dialect: 'postgresql',
  out: './src/server/db',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
