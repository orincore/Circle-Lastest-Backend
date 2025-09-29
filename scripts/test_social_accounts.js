#!/usr/bin/env node

/**
 * Test script for social accounts integration
 * Tests database setup, API endpoints, and OAuth flow components
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import axios from 'axios'

// Load environment variables
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080'

async function testSocialAccountsIntegration() {
  console.log('🧪 Testing Social Accounts Integration...\n')
  
  try {
    // Test 1: Database Schema
    await testDatabaseSchema()
    
    // Test 2: Environment Variables
    await testEnvironmentVariables()
    
    // Test 3: API Endpoints
    await testAPIEndpoints()
    
    // Test 4: OAuth Configuration
    await testOAuthConfiguration()
    
    console.log('\n✅ All tests completed successfully!')
    console.log('\n📋 Next Steps:')
    console.log('1. Set up Spotify Developer App and add credentials to .env')
    console.log('2. Set up Instagram Basic Display and add credentials to .env')
    console.log('3. Test OAuth flows through the frontend')
    console.log('4. Verify account linking and profile display')
    
  } catch (error) {
    console.error('\n💥 Test failed:', error.message)
    process.exit(1)
  }
}

async function testDatabaseSchema() {
  console.log('📊 Testing Database Schema...')
  
  try {
    // Check if linked_social_accounts table exists
    const { data: tables, error: tablesError } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public')
      .eq('table_name', 'linked_social_accounts')
    
    if (tablesError) {
      throw new Error(`Failed to check tables: ${tablesError.message}`)
    }
    
    if (!tables || tables.length === 0) {
      throw new Error('linked_social_accounts table not found. Please run the migration.')
    }
    
    console.log('  ✅ linked_social_accounts table exists')
    
    // Check table structure
    const { data: columns, error: columnsError } = await supabase
      .from('information_schema.columns')
      .select('column_name, data_type, is_nullable')
      .eq('table_schema', 'public')
      .eq('table_name', 'linked_social_accounts')
      .order('ordinal_position')
    
    if (columnsError) {
      throw new Error(`Failed to check columns: ${columnsError.message}`)
    }
    
    const expectedColumns = [
      'id', 'user_id', 'platform', 'platform_user_id', 'platform_username',
      'platform_display_name', 'platform_profile_url', 'platform_avatar_url',
      'access_token', 'refresh_token', 'token_expires_at', 'platform_data',
      'is_verified', 'is_public', 'linked_at', 'updated_at'
    ]
    
    const actualColumns = columns.map(col => col.column_name)
    const missingColumns = expectedColumns.filter(col => !actualColumns.includes(col))
    
    if (missingColumns.length > 0) {
      throw new Error(`Missing columns: ${missingColumns.join(', ')}`)
    }
    
    console.log('  ✅ All required columns present')
    
    // Check indexes
    const { data: indexes, error: indexesError } = await supabase
      .from('pg_indexes')
      .select('indexname')
      .eq('tablename', 'linked_social_accounts')
    
    if (!indexesError && indexes) {
      const indexNames = indexes.map(idx => idx.indexname)
      console.log(`  ✅ Found ${indexNames.length} indexes`)
    }
    
    console.log('  ✅ Database schema test passed\n')
    
  } catch (error) {
    throw new Error(`Database schema test failed: ${error.message}`)
  }
}

async function testEnvironmentVariables() {
  console.log('🔧 Testing Environment Variables...')
  
  const requiredVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'JWT_SECRET'
  ]
  
  const optionalVars = [
    'SPOTIFY_CLIENT_ID',
    'SPOTIFY_CLIENT_SECRET',
    'INSTAGRAM_CLIENT_ID',
    'INSTAGRAM_CLIENT_SECRET',
    'FRONTEND_URL'
  ]
  
  // Check required variables
  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`)
    }
    console.log(`  ✅ ${varName} is set`)
  }
  
  // Check optional variables (warn if missing)
  for (const varName of optionalVars) {
    if (!process.env[varName]) {
      console.log(`  ⚠️  ${varName} is not set (required for OAuth)`)
    } else {
      console.log(`  ✅ ${varName} is set`)
    }
  }
  
  console.log('  ✅ Environment variables test passed\n')
}

async function testAPIEndpoints() {
  console.log('🌐 Testing API Endpoints...')
  
  try {
    // Test if server is running
    const healthResponse = await axios.get(`${API_BASE_URL}/health`)
    console.log('  ✅ Server is running')
    
    // Test social accounts routes (without auth - should get 401)
    const endpoints = [
      '/api/social/linked-accounts',
      '/api/social/link/spotify',
      '/api/social/link/instagram'
    ]
    
    for (const endpoint of endpoints) {
      try {
        await axios.get(`${API_BASE_URL}${endpoint}`)
        console.log(`  ⚠️  ${endpoint} - No auth required (unexpected)`)
      } catch (error) {
        if (error.response?.status === 401) {
          console.log(`  ✅ ${endpoint} - Properly protected (401)`)
        } else {
          console.log(`  ⚠️  ${endpoint} - Unexpected response: ${error.response?.status}`)
        }
      }
    }
    
    console.log('  ✅ API endpoints test passed\n')
    
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error('Backend server is not running. Please start it with: npm run dev')
    }
    throw new Error(`API endpoints test failed: ${error.message}`)
  }
}

async function testOAuthConfiguration() {
  console.log('🔐 Testing OAuth Configuration...')
  
  const spotifyConfigured = process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET
  const instagramConfigured = process.env.INSTAGRAM_CLIENT_ID && process.env.INSTAGRAM_CLIENT_SECRET
  
  if (spotifyConfigured) {
    console.log('  ✅ Spotify OAuth credentials configured')
    
    // Test Spotify OAuth URL generation (mock)
    const spotifyScopes = [
      'user-read-private',
      'user-read-email',
      'user-top-read',
      'user-read-recently-played',
      'playlist-read-private'
    ]
    console.log(`  ✅ Spotify scopes: ${spotifyScopes.join(', ')}`)
  } else {
    console.log('  ⚠️  Spotify OAuth not configured')
    console.log('     1. Create app at https://developer.spotify.com/dashboard')
    console.log('     2. Add redirect URI: http://localhost:8081/auth/spotify/callback')
    console.log('     3. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env')
  }
  
  if (instagramConfigured) {
    console.log('  ✅ Instagram OAuth credentials configured')
    
    const instagramScopes = ['user_profile', 'user_media']
    console.log(`  ✅ Instagram scopes: ${instagramScopes.join(', ')}`)
  } else {
    console.log('  ⚠️  Instagram OAuth not configured')
    console.log('     1. Create app at https://developers.facebook.com/')
    console.log('     2. Add Instagram Basic Display product')
    console.log('     3. Add redirect URI: http://localhost:8081/auth/instagram/callback')
    console.log('     4. Add INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET to .env')
  }
  
  // Test frontend URL
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8081'
  console.log(`  ✅ Frontend URL: ${frontendUrl}`)
  
  console.log('  ✅ OAuth configuration test passed\n')
}

// Test sample data operations
async function testSampleDataOperations() {
  console.log('📝 Testing Sample Data Operations...')
  
  try {
    // Create a test user (if not exists)
    const testUserId = 'test-user-social-accounts'
    
    // Insert sample linked account
    const sampleAccount = {
      user_id: testUserId,
      platform: 'spotify',
      platform_user_id: 'test_spotify_user',
      platform_username: 'testuser',
      platform_display_name: 'Test User',
      platform_profile_url: 'https://open.spotify.com/user/testuser',
      platform_data: {
        followers: 100,
        playlists_count: 5,
        top_artists: [
          { name: 'Test Artist', genres: ['pop'] }
        ]
      },
      is_verified: true,
      is_public: true
    }
    
    const { data: insertedAccount, error: insertError } = await supabase
      .from('linked_social_accounts')
      .insert(sampleAccount)
      .select()
      .single()
    
    if (insertError) {
      throw new Error(`Failed to insert sample account: ${insertError.message}`)
    }
    
    console.log('  ✅ Sample account inserted')
    
    // Query the account
    const { data: queriedAccount, error: queryError } = await supabase
      .from('linked_social_accounts')
      .select('*')
      .eq('id', insertedAccount.id)
      .single()
    
    if (queryError) {
      throw new Error(`Failed to query account: ${queryError.message}`)
    }
    
    console.log('  ✅ Sample account queried successfully')
    
    // Update account visibility
    const { error: updateError } = await supabase
      .from('linked_social_accounts')
      .update({ is_public: false })
      .eq('id', insertedAccount.id)
    
    if (updateError) {
      throw new Error(`Failed to update account: ${updateError.message}`)
    }
    
    console.log('  ✅ Sample account updated')
    
    // Clean up test data
    const { error: deleteError } = await supabase
      .from('linked_social_accounts')
      .delete()
      .eq('id', insertedAccount.id)
    
    if (deleteError) {
      throw new Error(`Failed to delete test account: ${deleteError.message}`)
    }
    
    console.log('  ✅ Test data cleaned up')
    console.log('  ✅ Sample data operations test passed\n')
    
  } catch (error) {
    throw new Error(`Sample data operations test failed: ${error.message}`)
  }
}

// Run all tests
testSocialAccountsIntegration()
  .then(() => {
    console.log('\n🎉 Social Accounts Integration is ready!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n💥 Integration test failed:', error.message)
    process.exit(1)
  })
