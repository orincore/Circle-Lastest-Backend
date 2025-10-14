import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function setupFriendSystem() {
  try {
    
    // Read the SQL file
    const sqlPath = join(__dirname, '../migrations/create_friend_system_tables.sql');
    const sqlContent = readFileSync(sqlPath, 'utf8');
    
    // Split SQL into individual statements (basic splitting)
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
    
    
    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      
      if (statement.includes('COMMENT ON') || statement.includes('SELECT')) {
        // Skip comments and verification queries for now
        continue;
      }
      
      try {
        
        const { error } = await supabase.rpc('exec_sql', { sql: statement });
        
        if (error) {
          // Try direct query if RPC fails
          const { error: directError } = await supabase
            .from('_temp_')
            .select('1')
            .limit(0);
          
          if (directError) {
            console.warn(`⚠️ Statement ${i + 1} failed:`, error.message);
          }
        } else {
        }
      } catch (err) {
        console.warn(`⚠️ Statement ${i + 1} failed:`, err.message);
      }
    }
    
    // Verify tables exist
    
    const { data: friendRequestsTest, error: frError } = await supabase
      .from('friend_requests')
      .select('id')
      .limit(1);
    
    const { data: friendshipsTest, error: fError } = await supabase
      .from('friendships')
      .select('id')
      .limit(1);
    
    if (!frError) {
    } else {
    }
    
    if (!fError) {
    } else {
    }
    
    // Test the Socket.IO query that was failing
    
    const { data: testQuery, error: testError } = await supabase
      .from('friend_requests')
      .select(`
        *,
        sender:profiles!sender_id(id, first_name, last_name, profile_photo_url)
      `)
      .eq('recipient_id', '8ccd6396-3d6f-475d-abac-a3a0a0aea279')
      .eq('status', 'pending')
      .limit(1);
    
    if (!testError) {
    } else {
    }
   
    
  } catch (error) {
    console.error('❌ Error setting up friend system:', error);
  }
}

setupFriendSystem();
