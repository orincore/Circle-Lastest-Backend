import type { Profile } from '../repos/profiles.repo.js'
import { findById } from '../repos/profiles.repo.js'
import { supabase } from '../config/supabase.js'

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
    interests: Array.isArray(u.interests) ? u.interests : [],
    needs: Array.isArray(u.needs) ? u.needs : [],
    profilePhotoUrl: u.profile_photo_url ?? null,
    createdAt: u.created_at ?? null
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
      if (Array.isArray(input.interests)) allowed.interests = input.interests
      if (Array.isArray(input.needs)) allowed.needs = input.needs
      if (typeof input.profilePhotoUrl === 'string') allowed.profile_photo_url = input.profilePhotoUrl

      const { data, error } = await supabase
        .from(TABLE)
        .update(allowed)
        .eq('id', ctx.user.id)
        .select('*')
        .single()
      if (error) throw error
      return toUser(data as Profile)
    }
  }
}
