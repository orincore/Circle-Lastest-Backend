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
    interests: [String!]!
    needs: [String!]!
    profilePhotoUrl: String
    createdAt: String
  }

  type Query {
    health: String!
    me: User
  }

  input UpdateMeInput {
    username: String
    firstName: String
    lastName: String
    age: Int
    gender: String
    phoneNumber: String
    interests: [String!]
    needs: [String!]
    profilePhotoUrl: String
  }

  type Mutation {
    updateMe(input: UpdateMeInput!): User!
  }
`
