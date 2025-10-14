import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function createReceiptsTable() {
  try {
    
    // Check if table already exists
    const { data: existingTable, error: checkError } = await supabase
      .from('message_receipts')
      .select('id')
      .limit(1);

    if (!checkError) {
      return;
    }

    ;

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
    } else {
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

createReceiptsTable();
