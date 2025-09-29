import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function addTestReceipts() {
  try {
    console.log('🔍 Finding recent messages...');
    
    // Get recent messages to add receipts for
    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('id, sender_id, text, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (msgError) {
      console.error('Error fetching messages:', msgError);
      return;
    }

    console.log(`Found ${messages.length} recent messages`);

    // Get all users to simulate receipts from different users
    const { data: users, error: userError } = await supabase
      .from('profiles')
      .select('id')
      .limit(10);

    if (userError) {
      console.error('Error fetching users:', userError);
      return;
    }

    console.log(`Found ${users.length} users`);

    // Add some test receipts
    let receiptsAdded = 0;
    
    for (const message of messages.slice(0, 5)) { // Only process first 5 messages
      // Find a different user to simulate receipt from
      const otherUser = users.find(u => u.id !== message.sender_id);
      
      if (otherUser) {
        // Add delivered receipt
        const { error: deliveredError } = await supabase
          .from('message_receipts')
          .insert({
            message_id: message.id,
            user_id: otherUser.id,
            status: 'delivered'
          });

        if (!deliveredError) {
          console.log(`✅ Added delivered receipt for message: ${message.text?.substring(0, 30)}...`);
          receiptsAdded++;
        }

        // For some messages, also add read receipt
        if (receiptsAdded % 2 === 0) {
          const { error: readError } = await supabase
            .from('message_receipts')
            .insert({
              message_id: message.id,
              user_id: otherUser.id,
              status: 'read'
            });

          if (!readError) {
            console.log(`✅ Added read receipt for message: ${message.text?.substring(0, 30)}...`);
          }
        }
      }
    }

    console.log(`🎉 Added ${receiptsAdded} test receipts!`);
    console.log('Now refresh your chat list to see double ticks!');

  } catch (error) {
    console.error('Error adding test receipts:', error);
  }
}

addTestReceipts();
