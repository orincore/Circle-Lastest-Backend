import { Server as SocketIOServer, Socket } from 'socket.io';
import { supabase } from '../config/supabase.js';
import { NotificationService } from '../services/notificationService.js';

/**
 * SIMPLIFIED FRIEND REQUEST HANDLER
 * Uses single friendships table with status field
 * Status values: 'pending', 'accepted', 'blocked', 'inactive'
 */

interface FriendshipRecord {
  id: string;
  user1_id: string;
  user2_id: string;
  sender_id: string;
  status: 'pending' | 'accepted' | 'blocked' | 'inactive';
  created_at: string;
  updated_at: string;
}

// Helper function to get ordered user IDs (smaller ID first)
function getOrderedUserIds(userId1: string, userId2: string) {
  return userId1 < userId2 
    ? { user1_id: userId1, user2_id: userId2 }
    : { user1_id: userId2, user2_id: userId1 };
}

// Helper function to get the other user ID
function getOtherUserId(friendship: FriendshipRecord, currentUserId: string): string {
  return friendship.user1_id === currentUserId ? friendship.user2_id : friendship.user1_id;
}

export function setupFriendRequestHandlers(io: SocketIOServer, socket: Socket, userId: string) {
  console.log('👥 Setting up simplified friend request handlers for user:', userId);

  // ==========================================
  // SEND FRIEND REQUEST
  // ==========================================
  socket.on('friend:request:send', async (data: { receiverId: string }) => {
    try {
      const senderId = userId;
      const { receiverId } = data;

      console.log('📤 Friend request:', senderId, '→', receiverId);

      // Validate
      if (!receiverId || senderId === receiverId) {
        socket.emit('friend:request:error', { error: 'Invalid request' });
        return;
      }

      // Verify both users exist in profiles table
      const { data: senderExists } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', senderId)
        .maybeSingle();

      const { data: receiverExists } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', receiverId)
        .maybeSingle();

      if (!senderExists) {
        console.error('❌ Sender profile not found:', senderId);
        socket.emit('friend:request:error', { error: 'Your profile not found. Please log out and log in again.' });
        return;
      }

      if (!receiverExists) {
        console.error('❌ Receiver profile not found:', receiverId);
        socket.emit('friend:request:error', { error: 'User profile not found. They may have deleted their account.' });
        return;
      }

      const { user1_id, user2_id } = getOrderedUserIds(senderId, receiverId);

      // Check if friendship record already exists
      const { data: existing, error: checkError } = await supabase
        .from('friendships')
        .select('*')
        .eq('user1_id', user1_id)
        .eq('user2_id', user2_id)
        .maybeSingle();

      if (checkError) {
        console.error('❌ Error checking friendship:', checkError);
        console.error('Error details:', {
          code: checkError.code,
          message: checkError.message,
          details: checkError.details
        });
        socket.emit('friend:request:error', { error: 'Database error' });
        return;
      }

      // Handle existing friendship
      if (existing) {
        if (existing.status === 'accepted') {
          socket.emit('friend:request:error', { error: 'Already friends' });
          return;
        }
        if (existing.status === 'pending') {
          socket.emit('friend:request:error', { error: 'Request already sent' });
          return;
        }
        if (existing.status === 'blocked') {
          socket.emit('friend:request:error', { error: 'Cannot send request' });
          return;
        }
        // If inactive, update to pending with new sender
        const { data: updated, error: updateError } = await supabase
          .from('friendships')
          .update({ 
            status: 'pending', 
            sender_id: senderId,
            updated_at: new Date().toISOString() 
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (updateError) {
          console.error('❌ Error updating friendship:', updateError);
          console.error('Update error details:', {
            code: updateError.code,
            message: updateError.message,
            details: updateError.details
          });
          socket.emit('friend:request:error', { error: 'Failed to send request' });
          return;
        }

        // Get sender profile
        const { data: senderProfile } = await supabase
          .from('profiles')
          .select('id, first_name, last_name, profile_photo_url')
          .eq('id', senderId)
          .single();

        // Create notification
        await NotificationService.createNotification({
          recipient_id: receiverId,
          sender_id: senderId,
          type: 'friend_request',
          title: 'Friend Request',
          message: `${senderProfile?.first_name || 'Someone'} sent you a friend request`,
          data: {
            requestId: updated.id,
            userId: senderId,
            userName: senderProfile?.first_name || 'Someone',
            userAvatar: senderProfile?.profile_photo_url
          }
        });

        // Notify receiver
        io.to(receiverId).emit('friend:request:received', {
          request: updated,
          sender: senderProfile
        });

        // Confirm to sender
        socket.emit('friend:request:sent', { request: updated });
        console.log('✅ Friend request reactivated:', updated.id);
        return;
      }

      // Create new friend request
      const { data: newRequest, error: createError } = await supabase
        .from('friendships')
        .insert({
          user1_id,
          user2_id,
          sender_id: senderId,
          status: 'pending'
        })
        .select()
        .single();

      if (createError) {
        console.error('❌ Error creating friend request:', createError);
        console.error('Create error details:', {
          code: createError.code,
          message: createError.message,
          details: createError.details,
          hint: createError.hint
        });
        socket.emit('friend:request:error', { error: 'Failed to send request' });
        return;
      }

      // Get sender profile
      const { data: senderProfile } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, profile_photo_url')
        .eq('id', senderId)
        .single();

      // Create notification
      await NotificationService.createNotification({
        recipient_id: receiverId,
        sender_id: senderId,
        type: 'friend_request',
        title: 'Friend Request',
        message: `${senderProfile?.first_name || 'Someone'} sent you a friend request`,
        data: {
          requestId: newRequest.id,
          userId: senderId,
          userName: senderProfile?.first_name || 'Someone',
          userAvatar: senderProfile?.profile_photo_url
        }
      });

      // Notify receiver
      io.to(receiverId).emit('friend:request:received', {
        request: newRequest,
        sender: senderProfile
      });

      // Confirm to sender
      socket.emit('friend:request:sent', { request: newRequest });
      console.log('✅ Friend request sent:', newRequest.id);

    } catch (error: any) {
      console.error('❌ Error sending friend request:', error);
      console.error('Catch error details:', {
        message: error?.message,
        code: error?.code,
        stack: error?.stack
      });
      socket.emit('friend:request:error', { error: error?.message || 'Failed to send request' });
    }
  });

  // ==========================================
  // ACCEPT FRIEND REQUEST
  // ==========================================
  socket.on('friend:request:accept', async (data: { requestId: string }) => {
    try {
      const { requestId } = data;
      console.log('✅ Accepting friend request:', requestId);

      // Get the friendship record
      const { data: friendship, error: fetchError } = await supabase
        .from('friendships')
        .select('*')
        .eq('id', requestId)
        .single();

      if (fetchError || !friendship) {
        console.error('Friend request not found:', fetchError);
        socket.emit('friend:request:error', { error: 'Request not found' });
        return;
      }

      // Verify user is the receiver (not the sender)
      if (friendship.sender_id === userId) {
        socket.emit('friend:request:error', { error: 'Cannot accept your own request' });
        return;
      }

      // Verify status is pending
      if (friendship.status !== 'pending') {
        socket.emit('friend:request:error', { error: 'Request is not pending' });
        return;
      }

      // Update status to accepted
      const { data: updated, error: updateError } = await supabase
        .from('friendships')
        .update({ 
          status: 'accepted',
          updated_at: new Date().toISOString()
        })
        .eq('id', requestId)
        .select()
        .single();

      if (updateError) {
        console.error('Error accepting request:', updateError);
        socket.emit('friend:request:error', { error: 'Failed to accept request' });
        return;
      }

      // Get both user profiles
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, profile_photo_url')
        .in('id', [friendship.user1_id, friendship.user2_id]);

      const senderId = friendship.sender_id;
      const receiverId = getOtherUserId(friendship, senderId);

      const senderProfile = profiles?.find(p => p.id === senderId);
      const receiverProfile = profiles?.find(p => p.id === receiverId);

      // Delete friend request notifications
      await NotificationService.deleteFriendRequestNotifications(senderId, receiverId);

      // Notify both users
      io.to(senderId).emit('friend:request:accepted', {
        friendship: updated,
        friend: receiverProfile
      });

      io.to(receiverId).emit('friend:request:accepted', {
        friendship: updated,
        friend: senderProfile
      });

      console.log('✅ Friend request accepted:', requestId);

    } catch (error) {
      console.error('❌ Error accepting friend request:', error);
      socket.emit('friend:request:error', { error: 'Failed to accept request' });
    }
  });

  // ==========================================
  // DECLINE FRIEND REQUEST
  // ==========================================
  socket.on('friend:request:decline', async (data: { requestId: string }) => {
    try {
      const { requestId } = data;
      console.log('❌ Declining friend request:', requestId);

      // Get the friendship record
      const { data: friendship, error: fetchError } = await supabase
        .from('friendships')
        .select('*')
        .eq('id', requestId)
        .single();

      if (fetchError || !friendship) {
        socket.emit('friend:request:error', { error: 'Request not found' });
        return;
      }

      // Verify user is the receiver
      if (friendship.sender_id === userId) {
        socket.emit('friend:request:error', { error: 'Cannot decline your own request' });
        return;
      }

      // Delete the request (clean approach)
      const { error: deleteError } = await supabase
        .from('friendships')
        .delete()
        .eq('id', requestId);

      if (deleteError) {
        console.error('Error declining request:', deleteError);
        socket.emit('friend:request:error', { error: 'Failed to decline request' });
        return;
      }

      const senderId = friendship.sender_id;
      const receiverId = getOtherUserId(friendship, senderId);

      // Delete friend request notifications
      await NotificationService.deleteFriendRequestNotifications(senderId, receiverId);

      // Notify sender that request was declined
      io.to(senderId).emit('friend:request:declined', {
        requestId,
        declinedBy: receiverId
      });

      // Confirm to receiver
      socket.emit('friend:request:declined', { requestId });
      console.log('✅ Friend request declined:', requestId);

    } catch (error) {
      console.error('❌ Error declining friend request:', error);
      socket.emit('friend:request:error', { error: 'Failed to decline request' });
    }
  });

  // ==========================================
  // CANCEL FRIEND REQUEST
  // ==========================================
  socket.on('friend:request:cancel', async (data: { receiverId: string }) => {
    try {
      const senderId = userId;
      const { receiverId } = data;

      console.log('🚫 Cancelling friend request:', senderId, '→', receiverId);

      const { user1_id, user2_id } = getOrderedUserIds(senderId, receiverId);

      // Find and delete the pending request
      const { data: friendship, error: fetchError } = await supabase
        .from('friendships')
        .select('*')
        .eq('user1_id', user1_id)
        .eq('user2_id', user2_id)
        .eq('sender_id', senderId)
        .eq('status', 'pending')
        .maybeSingle();

      if (!friendship) {
        socket.emit('friend:request:error', { error: 'No pending request found' });
        return;
      }

      const { error: deleteError } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendship.id);

      if (deleteError) {
        console.error('Error cancelling request:', deleteError);
        socket.emit('friend:request:error', { error: 'Failed to cancel request' });
        return;
      }

      // Delete friend request notifications
      await NotificationService.deleteFriendRequestNotifications(senderId, receiverId);

      // Notify receiver
      io.to(receiverId).emit('friend:request:cancelled', {
        requestId: friendship.id,
        cancelledBy: senderId
      });

      // Confirm to sender
      socket.emit('friend:request:cancel:confirmed', { 
        requestId: friendship.id,
        success: true 
      });

      console.log('✅ Friend request cancelled:', friendship.id);

    } catch (error) {
      console.error('❌ Error cancelling friend request:', error);
      socket.emit('friend:request:error', { error: 'Failed to cancel request' });
    }
  });

  // ==========================================
  // GET PENDING REQUESTS
  // ==========================================
  socket.on('friend:requests:get', async () => {
    try {
      console.log('📋 Getting pending friend requests for:', userId);

      // Get all pending requests where user is the receiver
      const { data: requests, error } = await supabase
        .from('friendships')
        .select(`
          *,
          sender:profiles!sender_id(id, first_name, last_name, profile_photo_url)
        `)
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
        .eq('status', 'pending')
        .neq('sender_id', userId); // Only requests where user is receiver

      if (error) {
        console.error('Error fetching requests:', error);
        socket.emit('friend:requests:error', { error: 'Failed to fetch requests' });
        return;
      }

      socket.emit('friend:requests:list', { requests: requests || [] });
      console.log(`✅ Sent ${requests?.length || 0} pending requests`);

    } catch (error) {
      console.error('❌ Error getting friend requests:', error);
      socket.emit('friend:requests:error', { error: 'Failed to fetch requests' });
    }
  });

  // ==========================================
  // UNFRIEND
  // ==========================================
  socket.on('friend:unfriend', async (data: { friendId: string }) => {
    try {
      const { friendId } = data;
      console.log('💔 Unfriending:', userId, '↔', friendId);

      const { user1_id, user2_id } = getOrderedUserIds(userId, friendId);

      // Update status to inactive
      const { data: updated, error: updateError } = await supabase
        .from('friendships')
        .update({ 
          status: 'inactive',
          updated_at: new Date().toISOString()
        })
        .eq('user1_id', user1_id)
        .eq('user2_id', user2_id)
        .eq('status', 'accepted')
        .select()
        .single();

      if (updateError) {
        console.error('Error unfriending:', updateError);
        socket.emit('friend:unfriend:error', { error: 'Failed to unfriend' });
        return;
      }

      // Notify both users
      io.to(friendId).emit('friend:unfriended', {
        friendshipId: updated.id,
        unfriendedBy: userId
      });

      socket.emit('friend:unfriend:confirmed', {
        friendshipId: updated.id,
        success: true
      });

      console.log('✅ Unfriended:', updated.id);

    } catch (error) {
      console.error('❌ Error unfriending:', error);
      socket.emit('friend:unfriend:error', { error: 'Failed to unfriend' });
    }
  });

  // ==========================================
  // GET PENDING FRIEND REQUESTS
  // ==========================================
  socket.on('friend:requests:get_pending', async () => {
    try {
      console.log('📋 Getting pending friend requests for user:', userId);

      // Query friendships table for pending requests where user is the receiver
      const { data: friendships, error } = await supabase
        .from('friendships')
        .select('*')
        .eq('status', 'pending')
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Friend requests query error:', error);
        socket.emit('friend:requests:pending_list', { requests: [] });
        return;
      }

      // Filter to only show requests where current user is the receiver (not the sender)
      const requests = friendships?.filter(f => f.sender_id !== userId) || [];

      // If we have requests, get sender information from profiles
      if (requests && requests.length > 0) {
        const senderIds = requests.map(r => r.sender_id);
        
        // Get sender profiles
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, first_name, last_name, username, profile_photo_url')
          .in('id', senderIds);

        // Combine requests with sender information
        const requestsWithSenders = requests.map(request => {
          const senderProfile = profiles?.find(p => p.id === request.sender_id);
          
          return {
            id: request.id,
            sender_id: request.sender_id,
            status: request.status,
            created_at: request.created_at,
            sender: {
              id: request.sender_id,
              first_name: senderProfile?.first_name || null,
              last_name: senderProfile?.last_name || null,
              username: senderProfile?.username || null,
              profile_photo_url: senderProfile?.profile_photo_url || null
            }
          };
        });

        socket.emit('friend:requests:pending_list', { requests: requestsWithSenders });
        console.log('✅ Sent pending requests:', requestsWithSenders.length);
      } else {
        socket.emit('friend:requests:pending_list', { requests: [] });
      }

    } catch (error) {
      console.error('❌ Error getting pending requests:', error);
      socket.emit('friend:requests:pending_list', { requests: [] });
    }
  });
}
