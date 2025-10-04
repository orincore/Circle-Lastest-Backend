import type { Profile } from '../repos/profiles.repo.js'
import { findById, updateLocation, updatePreferences, findNearbyUsers, findUsersInArea } from '../repos/profiles.repo.js'
import { supabase } from '../config/supabase.js'
import { trackLocationUpdated, trackInterestUpdated } from '../services/activityService.js'

function toUser(u: Profile | null) {
  if (!u) return null
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    firstName: u.first_name,
    lastName: u.last_name,
    age: u.age,
    gender: u.gender,
    phoneNumber: u.phone_number ?? null,
    about: u.about ?? null,
    interests: Array.isArray(u.interests) ? u.interests : [],
    needs: Array.isArray(u.needs) ? u.needs : [],
    profilePhotoUrl: u.profile_photo_url ?? null,
    instagramUsername: u.instagram_username ?? null,
    location: u.latitude && u.longitude ? {
      latitude: u.latitude,
      longitude: u.longitude,
      address: u.location_address ?? null,
      city: u.location_city ?? null,
      country: u.location_country ?? null,
      updatedAt: u.location_updated_at ?? null
    } : null,
    preferences: {
      locationPreference: u.location_preference ?? 'nearby',
      agePreference: u.age_preference ?? 'flexible',
      friendshipLocationPriority: u.friendship_location_priority ?? true,
      relationshipDistanceFlexible: u.relationship_distance_flexible ?? true,
      updatedAt: u.preferences_updated_at ?? u.created_at ?? null
    },
    invisibleMode: u.invisible_mode ?? false,
    createdAt: u.created_at ?? null
  }
}

function toNearbyUser(u: Profile & { distance: number }) {
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    age: u.age,
    gender: u.gender,
    profilePhotoUrl: u.profile_photo_url ?? null,
    instagramUsername: u.instagram_username ?? null,
    interests: Array.isArray(u.interests) ? u.interests : [],
    needs: Array.isArray(u.needs) ? u.needs : [],
    location: {
      latitude: u.latitude!,
      longitude: u.longitude!,
      address: u.location_address ?? null,
      city: u.location_city ?? null,
      country: u.location_country ?? null,
      updatedAt: u.location_updated_at ?? null
    },
    distance: Math.round(u.distance * 100) / 100 // Round to 2 decimal places
  }
}

const TABLE = 'profiles'

export const resolvers = {
  Query: {
    health: () => 'ok',
    me: async (_: any, __: any, ctx: any) => {
      if (!ctx?.user?.id) return null
      const profile = await findById(ctx.user.id)
      return toUser(profile)
    },
    nearbyUsers: async (_: any, { latitude, longitude, radiusKm, limit }: any, ctx: any) => {
      if (!ctx?.user?.id) throw new Error('Unauthorized')
      
      const users = await findNearbyUsers({
        latitude,
        longitude,
        radiusKm: radiusKm || 50,
        excludeUserId: ctx.user.id,
        limit: limit || 100
      })
      
      return users.map(toNearbyUser)
    },
    usersInArea: async (_: any, { northEast, southWest, limit }: any, ctx: any) => {
      if (!ctx?.user?.id) throw new Error('Unauthorized')
      
      const users = await findUsersInArea({
        northEast,
        southWest,
        excludeUserId: ctx.user.id,
        limit: limit || 100
      })
      
      // Calculate distance from center of the area for sorting
      const centerLat = (northEast.latitude + southWest.latitude) / 2
      const centerLng = (northEast.longitude + southWest.longitude) / 2
      
      return users.map(u => ({
        ...toNearbyUser({ ...u, distance: 0 }),
        distance: calculateDistance(centerLat, centerLng, u.latitude!, u.longitude!)
      })).sort((a, b) => a.distance - b.distance)
    }
  },
  Mutation: {
    updateMe: async (_: any, { input }: any, ctx: any) => {
      if (!ctx?.user?.id) throw new Error('Unauthorized')
      const allowed: any = {}
      if (typeof input.username === 'string') allowed.username = input.username
      if (typeof input.firstName === 'string') allowed.first_name = input.firstName
      if (typeof input.lastName === 'string') allowed.last_name = input.lastName
      if (typeof input.age === 'number') allowed.age = input.age
      if (typeof input.gender === 'string') allowed.gender = input.gender
      if (typeof input.phoneNumber === 'string') allowed.phone_number = input.phoneNumber
      if (typeof input.about === 'string') {
        // Validate about field length
        const aboutText = input.about.trim()
        if (aboutText.length > 500) {
          throw new Error('About section must be less than 500 characters')
        }
        allowed.about = aboutText || null
      }
      if (Array.isArray(input.interests)) allowed.interests = input.interests
      if (Array.isArray(input.needs)) allowed.needs = input.needs
      if (typeof input.profilePhotoUrl === 'string') allowed.profile_photo_url = input.profilePhotoUrl
      if (typeof input.instagramUsername === 'string') allowed.instagram_username = input.instagramUsername
      if (typeof input.invisibleMode === 'boolean') allowed.invisible_mode = input.invisibleMode

      const { data, error } = await supabase
        .from(TABLE)
        .update(allowed)
        .eq('id', ctx.user.id)
        .select('*')
        .single()
      if (error) throw error
      
      // Track interests update activity for live feed if interests were updated
      if (Array.isArray(input.interests)) {
        try {
          await trackInterestUpdated(data as Profile, input.interests)
        } catch (error) {
          console.error('❌ Failed to track interests update activity:', error)
        }
      }
      
      return toUser(data as Profile)
    },
    updateLocation: async (_: any, { input }: any, ctx: any) => {
      if (!ctx?.user?.id) throw new Error('Unauthorized')
      
      const updatedProfile = await updateLocation(ctx.user.id, {
        latitude: input.latitude,
        longitude: input.longitude,
        address: input.address,
        city: input.city,
        country: input.country
      })
      
      // Track location update activity for live feed
      try {
        const locationName = input.city && input.country ? `${input.city}, ${input.country}` : 
                           input.city || input.country || 'Unknown Location'
        await trackLocationUpdated(updatedProfile, locationName)
      } catch (error) {
        console.error('❌ Failed to track location update activity:', error)
      }
      
      return toUser(updatedProfile)
    },
    updatePreferences: async (_: any, { input }: any, ctx: any) => {
      if (!ctx?.user?.id) throw new Error('Unauthorized')
      
      console.log('🔄 Updating preferences for user:', ctx.user.id, 'with input:', input)
      
      const updatedProfile = await updatePreferences(ctx.user.id, {
        locationPreference: input.locationPreference,
        agePreference: input.agePreference,
        friendshipLocationPriority: input.friendshipLocationPriority,
        relationshipDistanceFlexible: input.relationshipDistanceFlexible
      })
      
      console.log('✅ Preferences updated successfully for user:', ctx.user.id)
      return toUser(updatedProfile)
    }
  }
}

// Helper function for distance calculation (same as in profiles.repo.ts)
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
