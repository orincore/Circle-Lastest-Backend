#!/usr/bin/env node

/**
 * Script to test chat list updates when messages are marked as read
 * and total unread count badge functionality
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function testChatReadUpdates() {
  try {
    console.log('🧪 Testing chat read updates and unread count badge...')
    
    // Get a chat with unread messages
    const { data: chats, error: chatsError } = await supabase
      .from('chats')
      .select(`
        id,
        chat_members!inner(user_id, profiles!inner(first_name, last_name))
      `)
      .limit(1)
    
    if (chatsError || !chats || chats.length === 0) {
      console.error('❌ No chats found:', chatsError)
      return
    }
    
    const chat = chats[0]
    const chatId = chat.id
    const members = chat.chat_members
    
    console.log(`💬 Testing with chat: ${chatId}`)
    console.log(`👥 Chat members:`)
    members.forEach((member, index) => {
      const profile = member.profiles
      console.log(`   ${index + 1}. ${profile.first_name} ${profile.last_name} (${member.user_id})`)
    })
    
    // Get messages in this chat
    const { data: messages, error: messagesError } = await supabase
      .from('messages')
      .select('id, sender_id, text, created_at')
      .eq('chat_id', chatId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(5)
    
    if (messagesError) {
      console.error('❌ Error fetching messages:', messagesError)
      return
    }
    
    console.log(`\n📨 Recent messages in chat:`)
    if (messages && messages.length > 0) {
      messages.forEach((msg, index) => {
        const senderProfile = members.find(m => m.user_id === msg.sender_id)?.profiles
        const senderName = senderProfile ? `${senderProfile.first_name} ${senderProfile.last_name}` : 'Unknown'
        console.log(`   ${index + 1}. ${senderName}: "${msg.text}" (${msg.id})`)
      })
    } else {
      console.log('   No messages found')
    }
    
    // Check current unread counts for each member
    console.log(`\n📊 Current unread counts:`)
    for (const member of members) {
      const userId = member.user_id
      const profile = member.profiles
      
      // Get unread messages for this user
      const { data: unreadMessages } = await supabase
        .from('messages')
        .select('id,sender_id')
        .eq('chat_id', chatId)
        .eq('is_deleted', false)
        .not('sender_id', 'eq', userId)
      
      let unreadCount = 0
      if (unreadMessages && unreadMessages.length > 0) {
        const msgIds = unreadMessages.map(m => m.id)
        const { data: reads } = await supabase
          .from('message_receipts')
          .select('message_id')
          .eq('status', 'read')
          .eq('user_id', userId)
          .in('message_id', msgIds)
        
        const readIds = (reads || []).map(r => r.message_id)
        unreadCount = msgIds.filter(id => !readIds.includes(id)).length
      }
      
      console.log(`   ${profile.first_name} ${profile.last_name}: ${unreadCount} unread`)
    }
    
    // Get total unread messages across all chats for each user
    console.log(`\n🔢 Total unread messages across all chats:`)
    for (const member of members) {
      const userId = member.user_id
      const profile = member.profiles
      
      // Get all chats for this user
      const { data: userChats } = await supabase
        .from('chat_members')
        .select('chat_id')
        .eq('user_id', userId)
      
      let totalUnread = 0
      if (userChats) {
        for (const userChat of userChats) {
          const { data: chatMessages } = await supabase
            .from('messages')
            .select('id,sender_id')
            .eq('chat_id', userChat.chat_id)
            .eq('is_deleted', false)
            .not('sender_id', 'eq', userId)
          
          if (chatMessages && chatMessages.length > 0) {
            const msgIds = chatMessages.map(m => m.id)
            const { data: reads } = await supabase
              .from('message_receipts')
              .select('message_id')
              .eq('status', 'read')
              .eq('user_id', userId)
              .in('message_id', msgIds)
            
            const readIds = (reads || []).map(r => r.message_id)
            totalUnread += msgIds.filter(id => !readIds.includes(id)).length
          }
        }
      }
      
      console.log(`   ${profile.first_name} ${profile.last_name}: ${totalUnread} total unread`)
    }
    
    
    
  } catch (error) {
    console.error('💥 Test failed:', error)
  }
}

// Run the test
testChatReadUpdates()
  .then(() => {
    console.log('\n🏁 Test script completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('💥 Test script failed:', error)
    process.exit(1)
  })
