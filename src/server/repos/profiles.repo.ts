import { supabase } from '../config/supabase.js'

export interface Profile {
  id: string
  email: string
  username: string
  first_name: string
  last_name: string
  age: number
  gender: string
  phone_number?: string | null
  interests: string[]
  needs: string[]
  profile_photo_url?: string | null
  password_hash: string
  created_at?: string
}

const TABLE = 'profiles'

export async function findByEmail(email: string): Promise<Profile | null> {
  const { data, error } = await supabase.from(TABLE).select('*').eq('email', email).maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export async function findByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase.from(TABLE).select('*').eq('username', username).maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export async function createProfile(p: Omit<Profile, 'id' | 'created_at'>): Promise<Profile> {
  const { data, error } = await supabase.from(TABLE).insert({
    email: p.email,
    username: p.username,
    first_name: p.first_name,
    last_name: p.last_name,
    age: p.age,
    gender: p.gender,
    phone_number: p.phone_number ?? null,
    interests: p.interests,
    needs: p.needs,
    profile_photo_url: p.profile_photo_url ?? null,
    password_hash: p.password_hash
  }).select('*').single()
  if (error) throw error
  return data as Profile
}

export async function findById(id: string): Promise<Profile | null> {
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data as Profile | null
}
