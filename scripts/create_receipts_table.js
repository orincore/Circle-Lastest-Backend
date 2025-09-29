import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function createReceiptsTable() {
  try {
    console.log('🔧 Checking if message_receipts table exists...');
    
    // Check if table already exists
    const { data: existingTable, error: checkError } = await supabase
      .from('message_receipts')
      .select('id')
      .limit(1);

    if (!checkError) {
      console.log('✅ Table already exists!');
      return;
    }

    console.log('📝 Table does not exist, will need to be created manually.');
    console.log('Please run this SQL in your Supabase dashboard:');
    console.log(`
CREATE TABLE IF NOT EXISTS message_receipts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('delivered', 'read')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Ensure one receipt per message per user
  UNIQUE(message_id, user_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_message_receipts_message_id ON message_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_message_receipts_user_id ON message_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_message_receipts_status ON message_receipts(status);
CREATE INDEX IF NOT EXISTS idx_message_receipts_created_at ON message_receipts(created_at);

-- Add RLS policies
ALTER TABLE message_receipts ENABLE ROW LEVEL SECURITY;

-- Users can only see receipts for their own messages or receipts they created
CREATE POLICY "Users can view message receipts" ON message_receipts
    FOR SELECT USING (
        user_id = auth.uid() OR 
        message_id IN (
            SELECT id FROM messages WHERE sender_id = auth.uid()
        )
    );

-- Users can only create receipts for messages they received
CREATE POLICY "Users can create message receipts" ON message_receipts
    FOR INSERT WITH CHECK (
        user_id = auth.uid() AND
        message_id IN (
            SELECT id FROM messages WHERE sender_id != auth.uid()
        )
    );

-- Users can update their own receipts (e.g., delivered -> read)
CREATE POLICY "Users can update their own receipts" ON message_receipts
    FOR UPDATE USING (user_id = auth.uid());
    `);

    // Test the table by checking if it exists
    const { data: tables, error: listError } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_name', 'message_receipts')
      .eq('table_schema', 'public');

    if (listError) {
      console.error('❌ Error checking table:', listError);
      return;
    }

    if (tables && tables.length > 0) {
      console.log('✅ Table exists and is ready to use!');
    } else {
      console.log('❌ Table was not created properly');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

createReceiptsTable();
