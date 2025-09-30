import { supabase } from '../src/server/config/supabase.js'

async function setupActivityTable() {
  console.log('🔧 Setting up activity_feed table...')
  
  try {
    // Check if table exists by trying to select from it
    const { data, error } = await supabase
      .from('activity_feed')
      .select('id')
      .limit(1)

    if (error && error.code === '42P01') {
      console.log('📋 Table does not exist, creating it...')
      
      // Create the table using raw SQL
      const { error: createError } = await supabase.rpc('exec_sql', {
        sql: `
          CREATE TABLE IF NOT EXISTS activity_feed (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            data JSONB NOT NULL,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_activity_feed_timestamp ON activity_feed(timestamp DESC);
          CREATE INDEX IF NOT EXISTS idx_activity_feed_type ON activity_feed(type);
          CREATE INDEX IF NOT EXISTS idx_activity_feed_user_id ON activity_feed(user_id);
        `
      })

      if (createError) {
        console.error('❌ Failed to create table:', createError)
        console.log('💡 Please run the migration manually:')
        console.log('   psql -h localhost -U postgres -d circle_dev -f migrations/create_activity_feed_table.sql')
        return
      }

      console.log('✅ Table created successfully')
    } else if (error) {
      console.error('❌ Error checking table:', error)
      return
    } else {
      console.log('✅ Table already exists')
    }

    // Test inserting a sample activity
    const testActivity = {
      id: `test_${Date.now()}`,
      type: 'user_joined',
      data: {
        user_id: 'test-user',
        user_name: 'Test User',
        age: 25,
        location: 'Test City'
      },
      timestamp: new Date().toISOString(),
      user_id: null // Allow null for test
    }

    const { error: insertError } = await supabase
      .from('activity_feed')
      .insert(testActivity)

    if (insertError) {
      console.error('❌ Failed to insert test activity:', insertError)
      return
    }

    console.log('✅ Test activity inserted successfully')

    // Clean up test activity
    await supabase
      .from('activity_feed')
      .delete()
      .eq('id', testActivity.id)

    console.log('🧹 Test activity cleaned up')
    console.log('🎉 Activity feed table is ready!')

  } catch (error) {
    console.error('❌ Setup failed:', error)
    process.exit(1)
  }
}

// Run the setup
setupActivityTable().then(() => {
  console.log('✅ Setup completed')
  process.exit(0)
}).catch(error => {
  console.error('❌ Setup failed:', error)
  process.exit(1)
})
