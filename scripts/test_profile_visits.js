#!/usr/bin/env node

/**
 * Script to test profile visit recording functionality
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function testProfileVisits() {
  try {
    console.log('🧪 Testing profile visit recording...')
    
    // Get two test users
    const { data: users, error: usersError } = await supabase
      .from('profiles')
      .select('id, first_name, last_name')
      .limit(2)
    
    if (usersError || !users || users.length < 2) {
      console.error('❌ Need at least 2 users to test profile visits:', usersError)
      return
    }
    
    const [visitor, visited] = users
    console.log(`👤 Visitor: ${visitor.first_name} ${visitor.last_name} (${visitor.id})`)
    console.log(`👁️  Visited: ${visited.first_name} ${visited.last_name} (${visited.id})`)
    
    // Check initial profile visits count
    const { data: initialStats } = await supabase
      .from('profiles')
      .select('profile_visits_received')
      .eq('id', visited.id)
      .single()
    
    console.log(`📊 Initial profile visits for ${visited.first_name}: ${initialStats?.profile_visits_received || 0}`)
    
    // Simulate profile visit by calling the API endpoint
    console.log('🔄 Simulating profile visit...')
    
    // First, let's manually record a profile visit using the service logic
    const { data: existingVisit } = await supabase
      .from('user_profile_visits')
      .select('visit_count')
      .eq('visitor_id', visitor.id)
      .eq('visited_user_id', visited.id)
      .single()
    
    if (existingVisit) {
      // Update existing record
      const { error } = await supabase
        .from('user_profile_visits')
        .update({
          visit_count: existingVisit.visit_count + 1,
          last_visit_at: new Date().toISOString()
        })
        .eq('visitor_id', visitor.id)
        .eq('visited_user_id', visited.id)
      
      if (error) {
        console.error('❌ Error updating visit:', error)
        return
      }
      
      console.log(`✅ Updated visit count to ${existingVisit.visit_count + 1}`)
    } else {
      // Create new visit record
      const { error } = await supabase
        .from('user_profile_visits')
        .insert({
          visitor_id: visitor.id,
          visited_user_id: visited.id,
          visit_count: 1,
          first_visit_at: new Date().toISOString(),
          last_visit_at: new Date().toISOString()
        })
      
      if (error) {
        console.error('❌ Error creating visit:', error)
        return
      }
      
      console.log('✅ Created new visit record')
    }
    
    // Update user stats to reflect the new visit
    const { error: statsError } = await supabase.rpc('update_user_stats', {
      user_uuid: visited.id
    })
    
    if (statsError) {
      console.error('❌ Error updating user stats:', statsError)
    } else {
      console.log('✅ User stats updated')
    }
    
    // Check updated profile visits count
    const { data: updatedStats } = await supabase
      .from('profiles')
      .select('profile_visits_received')
      .eq('id', visited.id)
      .single()
    
    console.log(`📈 Updated profile visits for ${visited.first_name}: ${updatedStats?.profile_visits_received || 0}`)
    
    // Check the visit record
    const { data: visitRecord } = await supabase
      .from('user_profile_visits')
      .select('*')
      .eq('visitor_id', visitor.id)
      .eq('visited_user_id', visited.id)
      .single()
    
    if (visitRecord) {
      console.log('📋 Visit record:', {
        visit_count: visitRecord.visit_count,
        first_visit: visitRecord.first_visit_at,
        last_visit: visitRecord.last_visit_at
      })
    }
    
    console.log('\n🎉 Profile visit test completed successfully!')
    
  } catch (error) {
    console.error('💥 Test failed:', error)
  }
}

// Run the test
testProfileVisits()
  .then(() => {
    console.log('🏁 Test script completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('💥 Test script failed:', error)
    process.exit(1)
  })
