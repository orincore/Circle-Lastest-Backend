const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function applyMigration() {
  try {
    
    // Read the SQL migration file
    const migrationPath = path.join(__dirname, '../migrations/create_mark_chat_messages_read_function.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the migration
    const { error } = await supabase.rpc('exec_sql', { sql: migrationSQL });
    
    if (error) {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    }
    
    
    // Test the function
    const { data, error: testError } = await supabase.rpc('mark_chat_messages_read', {
      p_chat_id: '00000000-0000-0000-0000-000000000000', // Test UUID
      p_user_id: '00000000-0000-0000-0000-000000000000'  // Test UUID
    });
    
    if (testError && !testError.message.includes('does not exist')) {
    } else if (testError && testError.message.includes('does not exist')) {
    } else {
    }
    
  } catch (error) {
    console.error('❌ Error applying migration:', error);
    process.exit(1);
  }
}

applyMigration();
