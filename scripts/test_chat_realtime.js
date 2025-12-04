#!/usr/bin/env node

/**
 * Script to test real-time chat list updates
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function testChatRealtime() {
  try {
    console.log('🧪 Testing chat real-time functionality...')
    
    // Get two test users who are friends
    const { data: friendships, error: friendshipsError } = await supabase
      .from('friendships')
      .select(`
        user1_id,
        user2_id,
        user1:profiles!friendships_user1_id_fkey(id, first_name, last_name),
        user2:profiles!friendships_user2_id_fkey(id, first_name, last_name)
      `)
      .eq('status', 'active')
      .limit(1)
    
    if (friendshipsError || !friendships || friendships.length === 0) {
      console.error('❌ Need at least one active friendship to test chat:', friendshipsError)
      return
    }
    
    const friendship = friendships[0]
    const user1 = friendship.user1
    const user2 = friendship.user2
    
    console.log(`👥 Testing with friends:`)
    console.log(`   User 1: ${user1.first_name} ${user1.last_name} (${user1.id})`)
    console.log(`   User 2: ${user2.first_name} ${user2.last_name} (${user2.id})`)
    
    // Check if they have an existing chat
    const { data: existingChats } = await supabase
      .from('chat_members')
      .select('chat_id')
      .in('user_id', [user1.id, user2.id])
    
    let chatId = null
    if (existingChats && existingChats.length > 0) {
      // Find a chat where both users are members
      const chatCounts = {}
      existingChats.forEach(chat => {
        chatCounts[chat.chat_id] = (chatCounts[chat.chat_id] || 0) + 1
      })
      
      chatId = Object.entries(chatCounts).find(([id, count]) => count >= 2)?.[0]
    }
    
    if (!chatId) {
      console.log('📝 No existing chat found, would need to create one via API')
      console.log('💡 To test real-time updates:')
      console.log('   1. Create a chat between these users via the frontend')
      console.log('   2. Send messages and observe real-time updates in chat list')
      console.log('   3. Check browser console for socket event logs')
      return
    }
    
    console.log(`💬 Found existing chat: ${chatId}`)
    
    // Get current unread counts for both users
    const { data: user1Messages } = await supabase
      .from('messages')
      .select('id,sender_id')
      .eq('chat_id', chatId)
      .eq('is_deleted', false)
      .not('sender_id', 'eq', user1.id)
    
    const { data: user2Messages } = await supabase
      .from('messages')
      .select('id,sender_id')
      .eq('chat_id', chatId)
      .eq('is_deleted', false)
      .not('sender_id', 'eq', user2.id)
    
    console.log(`📊 Current message counts:`)
    console.log(`   Messages from ${user2.first_name} to ${user1.first_name}: ${user1Messages?.length || 0}`)
    console.log(`   Messages from ${user1.first_name} to ${user2.first_name}: ${user2Messages?.length || 0}`)
    
    // Get read receipt counts
    if (user1Messages?.length > 0) {
      const { data: user1Reads } = await supabase
        .from('message_receipts')
        .select('message_id')
        .eq('status', 'read')
        .eq('user_id', user1.id)
        .in('message_id', user1Messages.map(m => m.id))
      
      const user1UnreadCount = user1Messages.length - (user1Reads?.length || 0)
      console.log(`   ${user1.first_name}'s unread count: ${user1UnreadCount}`)
    }
    
    if (user2Messages?.length > 0) {
      const { data: user2Reads } = await supabase
        .from('message_receipts')
        .select('message_id')
        .eq('status', 'read')
        .eq('user_id', user2.id)
        .in('message_id', user2Messages.map(m => m.id))
      
      const user2UnreadCount = user2Messages.length - (user2Reads?.length || 0)
      console.log(`   ${user2.first_name}'s unread count: ${user2UnreadCount}`)
    }
    
    
  } catch (error) {
    console.error('💥 Test failed:', error)
  }
}

// Run the test
testChatRealtime()
  .then(() => {
    console.log('\n🏁 Test script completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('💥 Test script failed:', error)
    process.exit(1)
  })
