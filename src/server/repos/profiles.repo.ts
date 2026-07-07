import { and, eq, gte, ilike, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'

export interface Profile {
  id: string
  email: string
  username: string
  first_name: string
  last_name: string
  age: number
  date_of_birth?: string | null
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

type ProfileRow = typeof profiles.$inferSelect

/**
 * Bridges Drizzle's camelCase row shape back to the snake_case `Profile` shape
 * every other file in the codebase expects (unchanged since the supabase-js days).
 * Every future migration batch's repo file follows this same pattern.
 */
export function rowToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    first_name: row.firstName,
    last_name: row.lastName,
    age: row.age,
    date_of_birth: row.dateOfBirth,
    gender: row.gender,
    phone_number: row.phoneNumber,
    about: row.about,
    interests: row.interests,
    needs: row.needs,
    profile_photo_url: row.profilePhotoUrl,
    instagram_username: row.instagramUsername,
    password_hash: row.passwordHash,
    email_verified: row.emailVerified,
    email_verified_at: row.emailVerifiedAt,
    verification_status: row.verificationStatus,
    verified_at: row.verifiedAt,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    location_address: row.locationAddress,
    location_city: row.locationCity,
    location_country: row.locationCountry,
    location_updated_at: row.locationUpdatedAt,
    location_preference: row.locationPreference,
    age_preference: row.agePreference,
    friendship_location_priority: row.friendshipLocationPriority,
    relationship_distance_flexible: row.relationshipDistanceFlexible,
    preferences_updated_at: row.preferencesUpdatedAt,
    invisible_mode: row.invisibleMode,
    is_suspended: row.isSuspended,
    suspension_reason: row.suspensionReason,
    suspended_at: row.suspendedAt,
    suspension_ends_at: row.suspensionEndsAt,
    deleted_at: row.deletedAt,
    deletion_reason: row.deletionReason,
    deletion_feedback: row.deletionFeedback,
    created_at: row.createdAt ?? undefined,
  }
}

export async function findByEmail(email: string): Promise<Profile | null> {
  const rows = await db.select().from(profiles).where(eq(profiles.email, email)).limit(1)
  return rows[0] ? rowToProfile(rows[0]) : null
}

export async function findByUsername(username: string): Promise<Profile | null> {
  // Search case-insensitively, same as the original `.ilike('username', username)`
  const rows = await db.select().from(profiles).where(ilike(profiles.username, username)).limit(1)
  return rows[0] ? rowToProfile(rows[0]) : null
}

export async function createProfile(p: Omit<Profile, 'id' | 'created_at'>): Promise<Profile> {
  const rows = await db.insert(profiles).values({
    email: p.email,
    username: p.username,
    firstName: p.first_name,
    lastName: p.last_name,
    age: p.age,
    dateOfBirth: p.date_of_birth ?? null,
    gender: p.gender,
    phoneNumber: p.phone_number ?? null,
    about: p.about,
    interests: p.interests,
    needs: p.needs,
    profilePhotoUrl: p.profile_photo_url ?? null,
    instagramUsername: p.instagram_username ?? null,
    passwordHash: p.password_hash,
  }).returning()
  return rowToProfile(rows[0])
}

export async function findById(id: string): Promise<Profile | null> {
  const rows = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1)
  return rows[0] ? rowToProfile(rows[0]) : null
}

export async function updateLocation(id: string, location: {
  latitude: number
  longitude: number
  address?: string
  city?: string
  country?: string
}): Promise<Profile> {
  const rows = await db.update(profiles).set({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    locationAddress: location.address || null,
    locationCity: location.city || null,
    locationCountry: location.country || null,
    locationUpdatedAt: new Date().toISOString(),
  }).where(eq(profiles.id, id)).returning()
  return rowToProfile(rows[0])
}

export async function updatePreferences(id: string, preferences: {
  locationPreference?: string
  agePreference?: string
  friendshipLocationPriority?: boolean
  relationshipDistanceFlexible?: boolean
}): Promise<Profile> {
  const updateData: Record<string, unknown> = {
    preferencesUpdatedAt: new Date().toISOString(),
  }
  if (preferences.locationPreference !== undefined) updateData.locationPreference = preferences.locationPreference
  if (preferences.agePreference !== undefined) updateData.agePreference = preferences.agePreference
  if (preferences.friendshipLocationPriority !== undefined) updateData.friendshipLocationPriority = preferences.friendshipLocationPriority
  if (preferences.relationshipDistanceFlexible !== undefined) updateData.relationshipDistanceFlexible = preferences.relationshipDistanceFlexible

  const rows = await db.update(profiles).set(updateData).where(eq(profiles.id, id)).returning()
  return rowToProfile(rows[0])
}

interface NearbyUserRow {
  [key: string]: unknown
  id: string; email: string; username: string; first_name: string; last_name: string
  age: number; gender: string; phone_number: string | null; about: string
  interests: string[]; needs: string[]; profile_photo_url: string | null
  instagram_username: string | null; password_hash: string
  email_verified: boolean | null; email_verified_at: string | null
  verification_status: string | null; verification_required: boolean | null
  verified_at: string | null; latitude: string | null; longitude: string | null
  location_address: string | null; location_city: string | null; location_country: string | null
  location_updated_at: string | null; location_preference: string | null; age_preference: string | null
  friendship_location_priority: boolean | null; relationship_distance_flexible: boolean | null
  preferences_updated_at: string | null; invisible_mode: boolean | null
  created_at: string | null; distance: string
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
  try {
    const result = await db.execute<NearbyUserRow>(
      sql`select * from find_nearby_users(${latitude}, ${longitude}, ${radiusKm}, ${excludeUserId ?? null}, ${limit})`
    )

    // Filter out users without complete profiles and invisible users (matches original RPC-path filtering)
    return result.rows
      .filter((u) => u.first_name && u.last_name && !u.invisible_mode)
      .map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        first_name: u.first_name,
        last_name: u.last_name,
        age: u.age,
        gender: u.gender,
        phone_number: u.phone_number,
        about: u.about,
        interests: u.interests,
        needs: u.needs,
        profile_photo_url: u.profile_photo_url,
        instagram_username: u.instagram_username,
        password_hash: u.password_hash,
        email_verified: u.email_verified,
        email_verified_at: u.email_verified_at,
        verification_status: u.verification_status,
        verified_at: u.verified_at,
        latitude: u.latitude !== null ? Number(u.latitude) : null,
        longitude: u.longitude !== null ? Number(u.longitude) : null,
        location_address: u.location_address,
        location_city: u.location_city,
        location_country: u.location_country,
        location_updated_at: u.location_updated_at,
        location_preference: u.location_preference,
        age_preference: u.age_preference,
        friendship_location_priority: u.friendship_location_priority,
        relationship_distance_flexible: u.relationship_distance_flexible,
        preferences_updated_at: u.preferences_updated_at,
        invisible_mode: u.invisible_mode,
        created_at: u.created_at ?? undefined,
        distance: Number(u.distance),
      }))
  } catch {
    // Fallback to basic query if the RPC function doesn't exist (matches original fallback behavior)
    const rows = await db.select().from(profiles).where(and(
      isNotNull(profiles.latitude),
      isNotNull(profiles.longitude),
      isNotNull(profiles.firstName),
      isNotNull(profiles.lastName),
      ne(profiles.id, excludeUserId || ''),
      or(isNull(profiles.invisibleMode), eq(profiles.invisibleMode, false)),
      eq(profiles.isSuspended, false),
      isNull(profiles.deletedAt),
    )).limit(limit)

    return rows
      .map((row) => {
        const p = rowToProfile(row)
        return { ...p, distance: calculateDistance(latitude, longitude, p.latitude!, p.longitude!) }
      })
      .filter((user) => user.distance <= radiusKm)
  }
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
  const rows = await db.select().from(profiles).where(and(
    gte(profiles.latitude, String(southWest.latitude)),
    lte(profiles.latitude, String(northEast.latitude)),
    gte(profiles.longitude, String(southWest.longitude)),
    lte(profiles.longitude, String(northEast.longitude)),
    isNotNull(profiles.latitude),
    isNotNull(profiles.longitude),
    ne(profiles.id, excludeUserId || ''),
    or(isNull(profiles.invisibleMode), eq(profiles.invisibleMode, false)),
    eq(profiles.isSuspended, false),
    isNull(profiles.deletedAt),
  )).limit(limit)

  // Additional filter for safety (matches original)
  return rows.map(rowToProfile).filter((user) => !user.is_suspended && !user.deleted_at)
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
