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
  about: string
  interests: string[]
  needs: string[]
  profile_photo_url?: string | null
  instagram_username?: string | null
  password_hash: string
  email_verified?: boolean | null
  email_verified_at?: string | null
  verification_status?: string | null
  verified_at?: string | null
  latitude?: number | null
  longitude?: number | null
  location_address?: string | null
  location_city?: string | null
  location_country?: string | null
  location_updated_at?: string | null
  location_preference?: string | null
  age_preference?: string | null
  friendship_location_priority?: boolean | null
  relationship_distance_flexible?: boolean | null
  preferences_updated_at?: string | null
  invisible_mode?: boolean | null
  is_suspended?: boolean | null
  suspension_reason?: string | null
  suspended_at?: string | null
  suspension_ends_at?: string | null
  deleted_at?: string | null
  deletion_reason?: string | null
  deletion_feedback?: string | null
  created_at?: string
}

const TABLE = 'profiles'

export async function findByEmail(email: string): Promise<Profile | null> {
  const { data, error } = await supabase.from(TABLE).select('*').eq('email', email).maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export async function findByUsername(username: string): Promise<Profile | null> {
  // Search case-insensitively using ilike
  const { data, error } = await supabase.from(TABLE).select('*').ilike('username', username).maybeSingle()
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
    about: p.about,
    interests: p.interests,
    needs: p.needs,
    profile_photo_url: p.profile_photo_url ?? null,
    instagram_username: p.instagram_username ?? null,
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

export async function updateLocation(id: string, location: {
  latitude: number
  longitude: number
  address?: string
  city?: string
  country?: string
}): Promise<Profile> {
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      latitude: location.latitude,
      longitude: location.longitude,
      location_address: location.address || null,
      location_city: location.city || null,
      location_country: location.country || null,
      location_updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select('*')
    .single()
  
  if (error) throw error
  return data as Profile
}

export async function updatePreferences(id: string, preferences: {
  locationPreference?: string
  agePreference?: string
  friendshipLocationPriority?: boolean
  relationshipDistanceFlexible?: boolean
}): Promise<Profile> {
  const updateData: any = {
    preferences_updated_at: new Date().toISOString()
  }
  
  if (preferences.locationPreference !== undefined) {
    updateData.location_preference = preferences.locationPreference
  }
  if (preferences.agePreference !== undefined) {
    updateData.age_preference = preferences.agePreference
  }
  if (preferences.friendshipLocationPriority !== undefined) {
    updateData.friendship_location_priority = preferences.friendshipLocationPriority
  }
  if (preferences.relationshipDistanceFlexible !== undefined) {
    updateData.relationship_distance_flexible = preferences.relationshipDistanceFlexible
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single()
  
  if (error) throw error
  return data as Profile
}

// Find nearby users within a radius (in kilometers)
export async function findNearbyUsers({
  latitude,
  longitude,
  radiusKm = 50,
  excludeUserId,
  limit = 100
}: {
  latitude: number
  longitude: number
  radiusKm?: number
  excludeUserId?: string
  limit?: number
}): Promise<(Profile & { distance: number })[]> {
  // Using Haversine formula for distance calculation
  // This is a simplified version - for production, consider using PostGIS
  const { data, error } = await supabase.rpc('find_nearby_users', {
    user_lat: latitude,
    user_lng: longitude,
    radius_km: radiusKm,
    exclude_user_id: excludeUserId || null,
    result_limit: limit
  })
  
  if (error) {
    // Fallback to basic query if RPC function doesn't exist
    console.warn('RPC function not found, using fallback query')
    const { data: fallbackData, error: fallbackError } = await supabase
      .from(TABLE)
      .select('*')
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .not('first_name', 'is', null)
      .not('last_name', 'is', null)
      .neq('id', excludeUserId || '')
      .or('invisible_mode.is.null,invisible_mode.eq.false') // Exclude invisible users
      .eq('is_suspended', false) // Exclude suspended users
      .is('deleted_at', null) // Exclude deleted users
      .limit(limit)
    
    if (fallbackError) throw fallbackError
    
    // Calculate distance client-side for fallback
    return (fallbackData || []).map(user => ({
      ...user,
      distance: calculateDistance(latitude, longitude, user.latitude!, user.longitude!)
    })).filter(user => user.distance <= radiusKm)
  }
  
  // Filter out users without complete profiles, invisible users, suspended users, and deleted users
  return (data || []).filter((user: any) => 
    user.first_name && 
    user.last_name && 
    (!user.invisible_mode || user.invisible_mode === false) &&
    !user.is_suspended &&
    !user.deleted_at
  )
}

// Find users within a bounding box (for map viewport)
export async function findUsersInArea({
  northEast,
  southWest,
  excludeUserId,
  limit = 100
}: {
  northEast: { latitude: number; longitude: number }
  southWest: { latitude: number; longitude: number }
  excludeUserId?: string
  limit?: number
}): Promise<Profile[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .gte('latitude', southWest.latitude)
    .lte('latitude', northEast.latitude)
    .gte('longitude', southWest.longitude)
    .lte('longitude', northEast.longitude)
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)
    .neq('id', excludeUserId || '')
    .or('invisible_mode.is.null,invisible_mode.eq.false') // Exclude invisible users
    .eq('is_suspended', false) // Exclude suspended users
    .is('deleted_at', null) // Exclude deleted users
    .limit(limit)
  
  if (error) throw error
  
  // Additional filter for safety
  return (data || []).filter((user: any) => 
    !user.is_suspended && !user.deleted_at
  )
}

// Helper function to calculate distance between two points
function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371 // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}
