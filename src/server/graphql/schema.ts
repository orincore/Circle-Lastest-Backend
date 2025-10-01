import { gql } from 'graphql-tag'

export const typeDefs = gql`
  type User {
    id: ID!
    email: String
    username: String
    firstName: String
    lastName: String
    age: Int
    gender: String
    phoneNumber: String
    about: String
    interests: [String!]!
    needs: [String!]!
    profilePhotoUrl: String
    instagramUsername: String
    location: Location
    preferences: Preferences
    createdAt: String
  }

  type Preferences {
    locationPreference: String!
    agePreference: String!
    friendshipLocationPriority: Boolean!
    relationshipDistanceFlexible: Boolean!
    updatedAt: String!
  }

  type Location {
    latitude: Float!
    longitude: Float!
    address: String
    city: String
    country: String
    updatedAt: String!
  }

  type NearbyUser {
    id: ID!
    firstName: String
    lastName: String
    age: Int
    gender: String
    profilePhotoUrl: String
    instagramUsername: String
    location: Location!
    distance: Float! # Distance in kilometers
    interests: [String!]!
    needs: [String!]!
  }

  type Query {
    health: String!
    me: User
    nearbyUsers(latitude: Float!, longitude: Float!, radiusKm: Float = 50, limit: Int = 100): [NearbyUser!]!
    usersInArea(northEast: CoordinateInput!, southWest: CoordinateInput!, limit: Int = 100): [NearbyUser!]!
  }

  input CoordinateInput {
    latitude: Float!
    longitude: Float!
  }

  input UpdateMeInput {
    username: String
    firstName: String
    lastName: String
    age: Int
    gender: String
    phoneNumber: String
    about: String
    interests: [String!]
    needs: [String!]
    profilePhotoUrl: String
    instagramUsername: String
  }

  input LocationInput {
    latitude: Float!
    longitude: Float!
    address: String
    city: String
    country: String
  }

  input PreferencesInput {
    locationPreference: String
    agePreference: String
    friendshipLocationPriority: Boolean
    relationshipDistanceFlexible: Boolean
  }

  type Mutation {
    updateMe(input: UpdateMeInput!): User!
    updateLocation(input: LocationInput!): User!
    updatePreferences(input: PreferencesInput!): User!
  }
`
