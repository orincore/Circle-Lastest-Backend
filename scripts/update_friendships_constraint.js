import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function updateFriendshipsConstraint() {
  
  try {
    // Verify the constraint was updated
    const { data: constraints, error: verifyError } = await supabase
      .rpc('exec_sql', {
        sql: `SELECT 
                conname as constraint_name,
                pg_get_constraintdef(oid) as constraint_definition
              FROM pg_constraint 
              WHERE conname = 'check_friendships_status';`
      });
    
    if (verifyError) {
    } else {
    }
    
    // Test that we can now use 'inactive' status
    const { data: testData, error: testError } = await supabase
      .from('friendships')
      .select('status')
      .eq('status', 'inactive')
      .limit(1);
    
    if (testError) {
    } else {
    }
    
    
  } catch (error) {
    console.error('❌ Verification failed:', error);
  }
}

// Run the verification
updateFriendshipsConstraint();
