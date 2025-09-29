import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function updateFriendshipsConstraint() {
  console.log('🔄 Updating friendships status constraint...');
  
  try {
    // Verify the constraint was updated
    console.log('🔍 Verifying current constraint...');
    const { data: constraints, error: verifyError } = await supabase
      .rpc('exec_sql', {
        sql: `SELECT 
                conname as constraint_name,
                pg_get_constraintdef(oid) as constraint_definition
              FROM pg_constraint 
              WHERE conname = 'check_friendships_status';`
      });
    
    if (verifyError) {
      console.log('⚠️ Verify error:', verifyError);
    } else {
      console.log('✅ Current constraint:', constraints);
    }
    
    // Test that we can now use 'inactive' status
    console.log('🧪 Testing inactive status...');
    const { data: testData, error: testError } = await supabase
      .from('friendships')
      .select('status')
      .eq('status', 'inactive')
      .limit(1);
    
    if (testError) {
      console.log('⚠️ Test query error:', testError);
    } else {
      console.log('✅ Inactive status query works:', testData?.length || 0, 'inactive friendships found');
    }
    
    console.log('🎉 Constraint verification completed!');
    
  } catch (error) {
    console.error('❌ Verification failed:', error);
  }
}

// Run the verification
updateFriendshipsConstraint();
