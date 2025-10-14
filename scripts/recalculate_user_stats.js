#!/usr/bin/env node

/**
 * Script to recalculate user statistics for all users
 * This will fix the match count issue by updating all user stats
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function recalculateAllUserStats() {
  try {
    
    // Get all user IDs
    const { data: users, error: usersError } = await supabase
      .from('profiles')
      .select('id, first_name, last_name')
    
    if (usersError) {
      console.error('❌ Error fetching users:', usersError)
      return
    }
    
    
    let updated = 0
    let errors = 0
    
    // Process users in batches of 10
    for (let i = 0; i < users.length; i += 10) {
      const batch = users.slice(i, i + 10)
      
      await Promise.all(batch.map(async (user) => {
        try {
          // Call the update_user_stats function for each user
          const { error } = await supabase.rpc('update_user_stats', {
            user_uuid: user.id
          })
          
          if (error) {
            console.error(`❌ Error updating stats for ${user.first_name} ${user.last_name}:`, error)
            errors++
          } else {
            updated++
          }
        } catch (error) {
          console.error(`❌ Exception updating stats for ${user.first_name} ${user.last_name}:`, error)
          errors++
        }
      }))
      
      // Small delay between batches to avoid overwhelming the database
      if (i + 10 < users.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    
    
    
    if (errors === 0) {
    }
    
  } catch (error) {
    console.error('❌ Fatal error during stats recalculation:', error)
  }
}

// Run the script
recalculateAllUserStats()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error('💥 Script failed:', error)
    process.exit(1)
  })
