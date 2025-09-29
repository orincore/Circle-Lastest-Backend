import { supabase } from '../config/supabase.js'

export interface Chat {
  id: string
  created_at: string
  last_message_at: string | null
}

export interface ChatMember {
  chat_id: string
  user_id: string
  joined_at: string
}

export interface ChatMessage {
  id: string
  chat_id: string
  sender_id: string
  text: string
  created_at: string
  updated_at?: string
  is_edited?: boolean
  is_deleted?: boolean
}

export interface MessageReaction {
  id: string
  message_id: string
  user_id: string
  emoji: string
  created_at: string
}

export interface ChatDeletion {
  id: string
  chat_id: string
  user_id: string
  deleted_at: string
  created_at: string
}

export async function ensureChatForUsers(a: string, b: string): Promise<Chat> {
  // Find an existing 1:1 chat for these two users
  const { data: existing, error: findErr } = await supabase
    .from('chat_members')
    .select('chat_id')
    .in('user_id', [a, b])
  if (findErr) throw findErr

  if (existing && existing.length) {
    // Count members per chat_id
    const counts: Record<string, number> = {}
    for (const row of existing) counts[row.chat_id] = (counts[row.chat_id] || 0) + 1
    const chatId = Object.entries(counts).find(([, c]) => c >= 2)?.[0]
    if (chatId) {
      const { data, error } = await supabase.from('chats').select('*').eq('id', chatId).maybeSingle()
      if (error) throw error
      if (data) return data as Chat
    }
  }

  // Create a new chat and add members
  const { data: chat, error: chatErr } = await supabase.from('chats').insert({}).select('*').single()
  if (chatErr) throw chatErr
  const { error: mErr } = await supabase.from('chat_members').insert([
    { chat_id: chat.id, user_id: a },
    { chat_id: chat.id, user_id: b },
  ])
  if (mErr) throw mErr
  return chat as Chat
}

export async function getUserInbox(userId: string) {
  // Get chats the user is a member of
  const { data: memberships, error: mErr } = await supabase
    .from('chat_members')
    .select('chat_id')
    .eq('user_id', userId)
  if (mErr) throw mErr
  const chatIds = (memberships || []).map((m) => m.chat_id)
  if (!chatIds.length) return []

  // Fetch chats
  const { data: chats, error: cErr } = await supabase
    .from('chats')
    .select('*')
    .in('id', chatIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (cErr) throw cErr

  // For each chat, find the other participant to display name
  const results = [] as Array<{ chat: Chat; lastMessage: ChatMessage | null; unreadCount: number; otherId?: string; otherName?: string; otherProfilePhoto?: string }>
  // Preload members for all chats
  const { data: members, error: memErr } = await supabase
    .from('chat_members')
    .select('chat_id, user_id')
    .in('chat_id', chatIds)
  if (memErr) throw memErr
  const otherIdsSet = new Set<string>()
  // Get user's chat deletion records to filter out cleared chats and messages
  const { data: deletions, error: delErr } = await supabase
    .from('chat_deletions')
    .select('chat_id, deleted_at')
    .eq('user_id', userId)
  if (delErr) throw delErr
  
  const deletionMap = new Map((deletions || []).map(d => [d.chat_id, d.deleted_at]))

  for (const chat of chats as Chat[]) {
    // Check if user has cleared this chat
    const deletedAt = deletionMap.get(chat.id)
    
    let lastMessageQuery = supabase
      .from('messages')
      .select('*')
      .eq('chat_id', chat.id)
      .eq('is_deleted', false) // Only get non-deleted messages for last message
      .order('created_at', { ascending: false })
      .limit(1)
    
    // If user cleared this chat, only get messages after the clear date
    if (deletedAt) {
      lastMessageQuery = lastMessageQuery.gt('created_at', deletedAt)
    }
    
    const { data: last, error: lmErr } = await lastMessageQuery.maybeSingle()
    if (lmErr) throw lmErr

    const lastMessage = last ? (last as ChatMessage) : null
    
    // If user cleared the chat and there are no new messages, skip this chat from inbox
    if (deletedAt && !lastMessage) {
      continue
    }

    // Compute unread: messages in chat not sent by user and without a read receipt by user
    let unreadQuery = supabase
      .from('messages')
      .select('id,sender_id')
      .eq('chat_id', chat.id)
      .eq('is_deleted', false) // Only count non-deleted messages for unread count
      .not('sender_id', 'eq', userId)
    
    // If user cleared this chat, only count messages after the clear date for unread
    if (deletedAt) {
      unreadQuery = unreadQuery.gt('created_at', deletedAt)
    }
    
    const { data: msgs, error: msgsErr } = await unreadQuery
    if (msgsErr) throw msgsErr
    const msgIds = (msgs || []).map(m => m.id)
    let readIds: string[] = []
    if (msgIds.length) {
      const { data: reads, error: rErr } = await supabase
        .from('message_receipts')
        .select('message_id')
        .eq('status', 'read')
        .eq('user_id', userId)
      if (rErr) throw rErr
      readIds = (reads || []).map(r => r.message_id)
    }
    const unreadCount = msgIds.filter(id => !readIds.includes(id)).length

    // find other id in this chat (assumes 1:1 for now)
    const mems = (members || []).filter((m: { chat_id: string; user_id: string }) => m.chat_id === chat.id)
    const otherId = mems.map((m: { user_id: string }) => m.user_id).find((id: string) => id !== userId)
    if (otherId) otherIdsSet.add(otherId)

    results.push({ chat, lastMessage, unreadCount, otherId })
  }

  // fetch names and profile photos for others
  if (otherIdsSet.size) {
    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, profile_photo_url')
      .in('id', Array.from(otherIdsSet))
    if (!pErr && profiles) {
      const nameMap = new Map((profiles as any[]).map((p) => [p.id, `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()]))
      const photoMap = new Map((profiles as any[]).map((p) => [p.id, p.profile_photo_url]))
      for (const item of results) {
        if (item.otherId) {
          item.otherName = nameMap.get(item.otherId)
          item.otherProfilePhoto = photoMap.get(item.otherId)
        }
      }
    }
  }

  // Get message receipt status for user's own messages (optimized single query)
  const userMessageIds = results
    .filter(item => item.lastMessage && item.lastMessage.sender_id === userId)
    .map(item => item.lastMessage!.id);

  if (userMessageIds.length > 0) {
    try {
      // Get all receipts for user's messages in a single query
      const { data: receipts, error: receiptsErr } = await supabase
        .from('message_receipts')
        .select('message_id, status')
        .in('message_id', userMessageIds)
        .order('created_at', { ascending: false });

      if (!receiptsErr && receipts) {
        // Create a map of message_id -> highest status
        const statusMap = new Map<string, string>();
        
        for (const receipt of receipts) {
          const currentStatus = statusMap.get(receipt.message_id);
          // Priority: read > delivered
          if (!currentStatus || 
              (receipt.status === 'read') || 
              (receipt.status === 'delivered' && currentStatus !== 'read')) {
            statusMap.set(receipt.message_id, receipt.status);
          }
        }

        // Apply status to messages
        for (const item of results) {
          if (item.lastMessage && item.lastMessage.sender_id === userId) {
            const status = statusMap.get(item.lastMessage.id) || 'sent';
            (item.lastMessage as any).status = status;
          }
        }
      } else {
        // Default all user messages to 'sent' if query fails
        for (const item of results) {
          if (item.lastMessage && item.lastMessage.sender_id === userId) {
            (item.lastMessage as any).status = 'sent';
          }
        }
      }
    } catch (error) {
      console.error('Error fetching message receipts:', error);
      // Default all user messages to 'sent' on error
      for (const item of results) {
        if (item.lastMessage && item.lastMessage.sender_id === userId) {
          (item.lastMessage as any).status = 'sent';
        }
      }
    }
  }
  return results
}

export async function getChatMessages(chatId: string, limit = 30, before?: string, userId?: string) {
  let q = supabase
    .from('messages')
    .select(`
      *,
      reactions:message_reactions(
        id,
        user_id,
        emoji,
        created_at
      ),
      receipts:message_receipts(
        user_id,
        status
      )
    `)
    .eq('chat_id', chatId)
    .eq('is_deleted', false) // Only return non-deleted messages
    .order('created_at', { ascending: false })
    .limit(limit)
  
  if (before) q = q.lt('created_at', before)
  
  // If userId is provided, filter out messages that were sent before the user cleared the chat
  if (userId) {
    // Get the user's chat deletion record to see when they cleared the chat
    const { data: deletion } = await supabase
      .from('chat_deletions')
      .select('deleted_at')
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .maybeSingle()
    
    if (deletion) {
      // Only show messages created after the user cleared the chat
      q = q.gt('created_at', deletion.deleted_at)
    }
  }
  
  const { data, error } = await q
  if (error) throw error
  return (data || []) as (ChatMessage & { reactions: MessageReaction[]; receipts: { user_id: string; status: string }[] })[]
}

export async function insertMessage(chatId: string, senderId: string, text: string): Promise<ChatMessage> {
  // Insert the message
  const { data, error } = await supabase
    .from('messages')
    .insert({ chat_id: chatId, sender_id: senderId, text })
    .select('*')
    .single()
  if (error) throw error

  // Update chat last_message_at (best-effort)
  try {
    await supabase
      .from('chats')
      .update({ last_message_at: (data as any)?.created_at ?? new Date().toISOString() })
      .eq('id', chatId)
  } catch {}

  return data as ChatMessage
}

export async function insertReceipt(messageId: string, userId: string, status: 'delivered' | 'read') {
  try {
    console.log(`📝 Inserting ${status} receipt for message ${messageId} by user ${userId}`);
    
    // Use upsert to handle duplicates gracefully without errors
    const { error } = await supabase
      .from('message_receipts')
      .upsert(
        { message_id: messageId, user_id: userId, status },
        { 
          onConflict: 'message_id,user_id,status',
          ignoreDuplicates: true 
        }
      )
      .select('id')
    
    if (error) {
      console.error(`❌ Receipt insert failed:`, error);
      
      // For network errors (fetch failed), don't throw - just log and continue
      if (error.message?.includes('fetch failed') || error.message?.includes('TypeError: fetch failed')) {
        console.warn(`🌐 Network error inserting receipt - continuing without throwing`);
        return; // Don't throw, just return
      }
      
      throw error;
    } else {
      console.log(`✅ Receipt processed successfully (inserted or already exists)`);
    }
  } catch (error) {
    // Handle network errors gracefully
    if (error instanceof TypeError && error.message?.includes('fetch failed')) {
      console.warn(`🌐 Network connectivity issue inserting ${status} receipt - skipping:`, {
        messageId,
        userId,
        error: error.message
      });
      return; // Don't throw for network errors
    }
    
    console.error(`❌ Failed to insert ${status} receipt:`, {
      messageId,
      userId,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : error
    });
    throw error;
  }
}

export async function editMessage(messageId: string, userId: string, newText: string): Promise<ChatMessage> {
  // Ensure ownership
  const { data: msg, error: findErr } = await supabase
    .from('messages')
    .select('id, sender_id')
    .eq('id', messageId)
    .maybeSingle()
  if (findErr) throw findErr
  if (!msg || msg.sender_id !== userId) {
    const e: any = new Error('Forbidden')
    e.status = 403
    throw e
  }

  // Update the message
  const { data, error } = await supabase
    .from('messages')
    .update({ 
      text: newText, 
      updated_at: new Date().toISOString(),
      is_edited: true 
    })
    .eq('id', messageId)
    .select('*')
    .single()
  if (error) throw error
  return data as ChatMessage
}

export async function deleteMessage(chatId: string, messageId: string, userId: string) {
  // ensure ownership
  const { data: msg, error: findErr } = await supabase
    .from('messages')
    .select('id, chat_id, sender_id')
    .eq('id', messageId)
    .maybeSingle()
  if (findErr) throw findErr
  if (!msg || msg.chat_id !== chatId || msg.sender_id !== userId) {
    const e: any = new Error('Forbidden')
    e.status = 403
    throw e
  }

  // Soft delete by marking as deleted instead of hard delete
  const { error } = await supabase
    .from('messages')
    .update({ 
      is_deleted: true,
      text: 'This message was deleted',
      updated_at: new Date().toISOString()
    })
    .eq('id', messageId)
  if (error) throw error
}

export async function toggleReaction(messageId: string, userId: string, emoji: string): Promise<{ action: 'added' | 'removed', reaction?: MessageReaction }> {
  // Check if reaction already exists
  const { data: existing, error: checkErr } = await supabase
    .from('message_reactions')
    .select('*')
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji)
    .maybeSingle()
  if (checkErr) throw checkErr

  if (existing) {
    // Reaction exists, remove it
    const { error: deleteErr } = await supabase
      .from('message_reactions')
      .delete()
      .eq('id', existing.id)
    if (deleteErr) throw deleteErr
    return { action: 'removed', reaction: existing as MessageReaction }
  }

  // Add new reaction
  const { data, error } = await supabase
    .from('message_reactions')
    .insert({ message_id: messageId, user_id: userId, emoji })
    .select('*')
    .single()
  if (error) throw error
  return { action: 'added', reaction: data as MessageReaction }
}

// Keep the old function for backward compatibility
export async function addReaction(messageId: string, userId: string, emoji: string): Promise<MessageReaction> {
  const result = await toggleReaction(messageId, userId, emoji)
  if (result.action === 'removed') {
    throw new Error('Reaction was removed (toggled off)')
  }
  return result.reaction!
}

export async function removeReaction(messageId: string, userId: string, emoji: string) {
  const { error } = await supabase
    .from('message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji)
  if (error) throw error
}

// Chat mute settings functions
export interface ChatMuteSetting {
  id: string
  user_id: string
  chat_id: string
  is_muted: boolean
  muted_until?: string | null
  created_at: string
  updated_at: string
}

export async function getChatMuteSetting(userId: string, chatId: string): Promise<ChatMuteSetting | null> {
  try {
    const { data, error } = await supabase
      .from('chat_mute_settings')
      .select('*')
      .eq('user_id', userId)
      .eq('chat_id', chatId)
      .maybeSingle()
    
    if (error) {
      console.error('Error getting chat mute setting:', error)
      // If table doesn't exist, return null (not muted)
      if (error.code === '42P01') { // Table doesn't exist
        console.log('chat_mute_settings table does not exist, treating as not muted')
        return null
      }
      throw error
    }
    return data as ChatMuteSetting | null
  } catch (error) {
    console.error('Failed to get chat mute setting:', error)
    return null // Default to not muted if there's an error
  }
}

export async function setChatMuteSetting(userId: string, chatId: string, isMuted: boolean, mutedUntil?: string): Promise<ChatMuteSetting> {
  try {
    const { data, error } = await supabase
      .from('chat_mute_settings')
      .upsert({
        user_id: userId,
        chat_id: chatId,
        is_muted: isMuted,
        muted_until: mutedUntil || null,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,chat_id'
      })
      .select('*')
      .single()
    
    if (error) {
      console.error('Error setting chat mute setting:', error)
      if (error.code === '42P01') { // Table doesn't exist
        throw new Error('chat_mute_settings table does not exist. Please run the database migration.')
      }
      throw error
    }
    return data as ChatMuteSetting
  } catch (error) {
    console.error('Failed to set chat mute setting:', error)
    throw error
  }
}

export async function isChatMuted(userId: string, chatId: string): Promise<boolean> {
  console.log('Checking if chat is muted:', { userId, chatId })
  const setting = await getChatMuteSetting(userId, chatId)
  console.log('Retrieved mute setting:', setting)
  
  if (!setting) {
    console.log('No mute setting found, chat is not muted')
    return false
  }
  
  // Check if temporarily muted and time has expired
  if (setting.muted_until) {
    const mutedUntil = new Date(setting.muted_until)
    const now = new Date()
    if (now > mutedUntil) {
      // Mute period expired, update setting
      console.log('Mute period expired, updating setting')
      await setChatMuteSetting(userId, chatId, false)
      return false
    }
  }
  
  console.log('Final mute status:', setting.is_muted)
  return setting.is_muted
}

export async function getMessageReactions(messageId: string): Promise<MessageReaction[]> {
  const { data, error } = await supabase
    .from('message_reactions')
    .select('*')
    .eq('message_id', messageId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []) as MessageReaction[]
}
