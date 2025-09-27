import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'

// Use service role for server-side DB access if available; fallback to anon
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY
export const supabase = createClient(env.SUPABASE_URL, key, {
  auth: { persistSession: false, detectSessionInUrl: false }
})
