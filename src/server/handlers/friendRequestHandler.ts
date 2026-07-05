import { Server as SocketIOServer, Socket } from 'socket.io';
import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../config/db.js';
import { friendships, profiles } from '../db/schema.js';
import { NotificationService } from '../services/notificationService.js';

/**
 * SIMPLIFIED FRIEND REQUEST HANDLER
 * Uses single friendships table with status field
 * Status values: 'pending', 'accepted', 'blocked', 'inactive'
 */

type FriendshipRow = typeof friendships.$inferSelect;

// Helper function to get ordered user IDs (smaller ID first)
function getOrderedUserIds(userId1: string, userId2: string) {
  return userId1 < userId2
    ? { user1_id: userId1, user2_id: userId2 }
    : { user1_id: userId2, user2_id: userId1 };
}

// Helper function to get the other user ID
function getOtherUserId(friendship: { user1Id: string; user2Id: string }, currentUserId: string): string {
  return friendship.user1Id === currentUserId ? friendship.user2Id : friendship.user1Id;
}

// The frontend consumes the raw (snake_case) row shape that supabase-js used to
// return directly; keep that contract stable across the Drizzle rewrite.
function toFriendshipRow(f: FriendshipRow) {
  return {
    id: f.id,
    user1_id: f.user1Id,
    user2_id: f.user2Id,
    sender_id: f.senderId,
    status: f.status,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

function toProfilePayload(p?: { id: string; firstName: string | null; lastName: string | null; profilePhotoUrl: string | null }) {
  return p ? { id: p.id, first_name: p.firstName, last_name: p.lastName, profile_photo_url: p.profilePhotoUrl } : null;
}

export function setupFriendRequestHandlers(io: SocketIOServer, socket: Socket, userId: string) {

  // ==========================================
  // SEND FRIEND REQUEST
  // ==========================================
  socket.on('friend:request:send', async (data: { receiverId: string }) => {
    try {
      const senderId = userId;
      const { receiverId } = data;

      // Validate
      if (!receiverId || senderId === receiverId) {
        socket.emit('friend:request:error', { error: 'Invalid request' });
        return;
      }

      // Verify both users exist in profiles table
      const [senderExists] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, senderId)).limit(1);
      const [receiverExists] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, receiverId)).limit(1);

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
      let existing: FriendshipRow | undefined;
      try {
        [existing] = await db.select().from(friendships)
          .where(and(eq(friendships.user1Id, user1_id), eq(friendships.user2Id, user2_id)))
          .limit(1);
      } catch (checkError) {
        console.error('❌ Error checking friendship:', checkError);
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
        let updated: FriendshipRow | undefined;
        try {
          [updated] = await db.update(friendships)
            .set({ status: 'pending', senderId, updatedAt: new Date().toISOString() })
            .where(eq(friendships.id, existing.id))
            .returning();
        } catch (updateError) {
          console.error('❌ Error updating friendship:', updateError);
          socket.emit('friend:request:error', { error: 'Failed to send request' });
          return;
        }

        // Get sender profile
        const [senderProfile] = await db
          .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, profilePhotoUrl: profiles.profilePhotoUrl })
          .from(profiles).where(eq(profiles.id, senderId)).limit(1);

        // Create notification
        await NotificationService.createNotification({
          recipient_id: receiverId,
          sender_id: senderId,
          type: 'friend_request',
          title: 'Friend Request',
          message: `${senderProfile?.firstName || 'Someone'} sent you a friend request`,
          data: {
            requestId: updated!.id,
            userId: senderId,
            userName: senderProfile?.firstName || 'Someone',
            userAvatar: senderProfile?.profilePhotoUrl
          }
        });

        const updatedPayload = toFriendshipRow(updated!);

        // Notify receiver
        io.to(receiverId).emit('friend:request:received', {
          request: updatedPayload,
          sender: toProfilePayload(senderProfile)
        });

        // Confirm to sender
        socket.emit('friend:request:sent', { request: updatedPayload });
        return;
      }

      // Create new friend request
      let newRequest: FriendshipRow | undefined;
      try {
        [newRequest] = await db.insert(friendships)
          .values({ user1Id: user1_id, user2Id: user2_id, senderId, status: 'pending' })
          .returning();
      } catch (createError) {
        console.error('❌ Error creating friend request:', createError);
        socket.emit('friend:request:error', { error: 'Failed to send request' });
        return;
      }

      // Get sender profile
      const [senderProfile] = await db
        .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, profilePhotoUrl: profiles.profilePhotoUrl })
        .from(profiles).where(eq(profiles.id, senderId)).limit(1);

      // Create notification
      await NotificationService.createNotification({
        recipient_id: receiverId,
        sender_id: senderId,
        type: 'friend_request',
        title: 'Friend Request',
        message: `${senderProfile?.firstName || 'Someone'} sent you a friend request`,
        data: {
          requestId: newRequest!.id,
          userId: senderId,
          userName: senderProfile?.firstName || 'Someone',
          userAvatar: senderProfile?.profilePhotoUrl
        }
      });

      const newRequestPayload = toFriendshipRow(newRequest!);

      // Notify receiver
      io.to(receiverId).emit('friend:request:received', {
        request: newRequestPayload,
        sender: toProfilePayload(senderProfile)
      });

      // Confirm to sender
      socket.emit('friend:request:sent', { request: newRequestPayload });

    } catch (error: any) {
      console.error('❌ Error sending friend request:', error);
      socket.emit('friend:request:error', { error: error?.message || 'Failed to send request' });
    }
  });

  // ==========================================
  // ACCEPT FRIEND REQUEST
  // ==========================================
  socket.on('friend:request:accept', async (data: { requestId: string }) => {
    try {
      const { requestId } = data;

      // Get the friendship record
      const [friendship] = await db.select().from(friendships).where(eq(friendships.id, requestId)).limit(1);

      if (!friendship) {
        console.error('Friend request not found:', requestId);
        socket.emit('friend:request:error', { error: 'Request not found' });
        return;
      }

      // Verify user is the receiver (not the sender)
      if (friendship.senderId === userId) {
        socket.emit('friend:request:error', { error: 'Cannot accept your own request' });
        return;
      }

      // Verify status is pending
      if (friendship.status !== 'pending') {
        socket.emit('friend:request:error', { error: 'Request is not pending' });
        return;
      }

      // Update status to accepted
      let updated: FriendshipRow | undefined;
      try {
        [updated] = await db.update(friendships)
          .set({ status: 'accepted', updatedAt: new Date().toISOString() })
          .where(eq(friendships.id, requestId))
          .returning();
      } catch (updateError) {
        console.error('Error accepting request:', updateError);
        socket.emit('friend:request:error', { error: 'Failed to accept request' });
        return;
      }

      // Get both user profiles
      const profileRows = await db
        .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, profilePhotoUrl: profiles.profilePhotoUrl })
        .from(profiles)
        .where(inArray(profiles.id, [friendship.user1Id, friendship.user2Id]));

      const senderId = friendship.senderId!;
      const receiverId = getOtherUserId(friendship, senderId);

      const senderProfile = profileRows.find(p => p.id === senderId);
      const receiverProfile = profileRows.find(p => p.id === receiverId);

      // Delete friend request notifications
      await NotificationService.deleteFriendRequestNotifications(senderId, receiverId);

      const updatedPayload = toFriendshipRow(updated!);

      // Notify both users
      io.to(senderId).emit('friend:request:accepted', {
        friendship: updatedPayload,
        friend: toProfilePayload(receiverProfile)
      });

      io.to(receiverId).emit('friend:request:accepted', {
        friendship: updatedPayload,
        friend: toProfilePayload(senderProfile)
      });

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

      // Get the friendship record
      const [friendship] = await db.select().from(friendships).where(eq(friendships.id, requestId)).limit(1);

      if (!friendship) {
        socket.emit('friend:request:error', { error: 'Request not found' });
        return;
      }

      // Verify user is the receiver
      if (friendship.senderId === userId) {
        socket.emit('friend:request:error', { error: 'Cannot decline your own request' });
        return;
      }

      // Delete the request (clean approach)
      try {
        await db.delete(friendships).where(eq(friendships.id, requestId));
      } catch (deleteError) {
        console.error('Error declining request:', deleteError);
        socket.emit('friend:request:error', { error: 'Failed to decline request' });
        return;
      }

      const senderId = friendship.senderId!;
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

      const { user1_id, user2_id } = getOrderedUserIds(senderId, receiverId);

      // Find and delete the pending request
      const [friendship] = await db.select().from(friendships)
        .where(and(
          eq(friendships.user1Id, user1_id),
          eq(friendships.user2Id, user2_id),
          eq(friendships.senderId, senderId),
          eq(friendships.status, 'pending'),
        ))
        .limit(1);

      if (!friendship) {
        socket.emit('friend:request:error', { error: 'No pending request found' });
        return;
      }

      try {
        await db.delete(friendships).where(eq(friendships.id, friendship.id));
      } catch (deleteError) {
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
      // Get all pending requests where user is the receiver
      const rows = await db
        .select({
          id: friendships.id,
          user1Id: friendships.user1Id,
          user2Id: friendships.user2Id,
          senderId: friendships.senderId,
          status: friendships.status,
          createdAt: friendships.createdAt,
          updatedAt: friendships.updatedAt,
          senderProfileId: profiles.id,
          senderFirstName: profiles.firstName,
          senderLastName: profiles.lastName,
          senderProfilePhotoUrl: profiles.profilePhotoUrl,
        })
        .from(friendships)
        .leftJoin(profiles, eq(profiles.id, friendships.senderId))
        .where(and(
          or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
          eq(friendships.status, 'pending'),
          ne(friendships.senderId, userId), // Only requests where user is receiver
        ));

      const requests = rows.map(r => ({
        id: r.id,
        user1_id: r.user1Id,
        user2_id: r.user2Id,
        sender_id: r.senderId,
        status: r.status,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        sender: r.senderProfileId ? {
          id: r.senderProfileId,
          first_name: r.senderFirstName,
          last_name: r.senderLastName,
          profile_photo_url: r.senderProfilePhotoUrl,
        } : null,
      }));

      socket.emit('friend:requests:list', { requests });

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

      const { user1_id, user2_id } = getOrderedUserIds(userId, friendId);

      // Update status to inactive
      let updated: FriendshipRow | undefined;
      try {
        [updated] = await db.update(friendships)
          .set({ status: 'inactive', updatedAt: new Date().toISOString() })
          .where(and(
            eq(friendships.user1Id, user1_id),
            eq(friendships.user2Id, user2_id),
            eq(friendships.status, 'accepted'),
          ))
          .returning();
      } catch (updateError) {
        console.error('Error unfriending:', updateError);
        socket.emit('friend:unfriend:error', { error: 'Failed to unfriend' });
        return;
      }

      if (!updated) {
        console.error('Error unfriending: no accepted friendship found');
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
      // Query friendships table for pending requests where user is the receiver
      let rows: FriendshipRow[] = [];
      try {
        rows = await db.select().from(friendships)
          .where(and(
            eq(friendships.status, 'pending'),
            or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
          ))
          .orderBy(desc(friendships.createdAt));
      } catch (error) {
        console.error('Friend requests query error:', error);
        socket.emit('friend:requests:pending_list', { requests: [] });
        return;
      }

      // Filter to only show requests where current user is the receiver (not the sender)
      const requests = rows.filter(f => f.senderId !== userId);

      // If we have requests, get sender information from profiles
      if (requests.length > 0) {
        const senderIds = requests.map(r => r.senderId!);

        // Get sender profiles
        const profileRows = await db
          .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, username: profiles.username, profilePhotoUrl: profiles.profilePhotoUrl })
          .from(profiles)
          .where(inArray(profiles.id, senderIds));

        // Combine requests with sender information
        const requestsWithSenders = requests.map(request => {
          const senderProfile = profileRows.find(p => p.id === request.senderId);

          return {
            id: request.id,
            sender_id: request.senderId,
            status: request.status,
            created_at: request.createdAt,
            sender: {
              id: request.senderId,
              first_name: senderProfile?.firstName || null,
              last_name: senderProfile?.lastName || null,
              username: senderProfile?.username || null,
              profile_photo_url: senderProfile?.profilePhotoUrl || null
            }
          };
        });

        socket.emit('friend:requests:pending_list', { requests: requestsWithSenders });
      } else {
        socket.emit('friend:requests:pending_list', { requests: [] });
      }

    } catch (error) {
      console.error('❌ Error getting pending requests:', error);
      socket.emit('friend:requests:pending_list', { requests: [] });
    }
  });
}
