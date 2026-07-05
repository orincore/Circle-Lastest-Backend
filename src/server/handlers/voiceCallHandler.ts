import { Server as SocketIOServer, Socket } from 'socket.io';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { db } from '../config/db.js';
import { friendships, profiles, voiceCalls } from '../db/schema.js';

interface CallData {
  callId: string;
  callerId: string;
  receiverId: string;
  callerName?: string;
  callerAvatar?: string;
  callType: 'webrtc' | 'audio-fallback';
}

interface VoiceCallRecord {
  id: string;
  call_id: string;
  caller_id: string;
  receiver_id: string;
  call_type: 'webrtc' | 'audio-fallback';
  status: 'initiated' | 'ringing' | 'connected' | 'ended' | 'declined' | 'missed';
  started_at: string;
  connected_at?: string;
  ended_at?: string;
  duration_seconds: number;
  end_reason?: 'completed' | 'declined' | 'missed' | 'disconnected' | 'error';
}

// Map a Drizzle voice_calls row (camelCase) to the snake_case VoiceCallRecord shape
// consumed throughout this file and by the frontend.
function toVoiceCallRecord(row: typeof voiceCalls.$inferSelect): VoiceCallRecord {
  return {
    id: row.id,
    call_id: row.callId,
    caller_id: row.callerId,
    receiver_id: row.receiverId,
    call_type: row.callType as 'webrtc' | 'audio-fallback',
    status: row.status as VoiceCallRecord['status'],
    started_at: row.startedAt as string,
    connected_at: row.connectedAt ?? undefined,
    ended_at: row.endedAt ?? undefined,
    duration_seconds: row.durationSeconds ?? 0,
    end_reason: row.endReason as VoiceCallRecord['end_reason'],
  };
}

// Helper function to create call record in database
async function createCallRecord(callId: string, callerId: string, receiverId: string, callType: 'webrtc' | 'audio-fallback'): Promise<VoiceCallRecord | null> {
  try {
    const [row] = await db.insert(voiceCalls).values({
      callId,
      callerId,
      receiverId,
      callType,
      status: 'initiated',
    }).returning();

    return row ? toVoiceCallRecord(row) : null;
  } catch (error) {
    console.error('❌ Exception creating call record:', error);
    return null;
  }
}

// Helper function to update call status
async function updateCallStatus(callId: string, status: VoiceCallRecord['status'], endReason?: string): Promise<boolean> {
  try {
    const updateData: any = { status };

    if (status === 'connected') {
      updateData.connectedAt = new Date().toISOString();
    } else if (status === 'ended' || status === 'declined' || status === 'missed') {
      updateData.endedAt = new Date().toISOString();
      if (endReason) {
        updateData.endReason = endReason;
      }
    }

    await db.update(voiceCalls).set(updateData).where(eq(voiceCalls.callId, callId));

    return true;
  } catch (error) {
    console.error('❌ Exception updating call status:', error);
    return false;
  }
}

// Helper function to get active calls from database
async function getActiveCallsFromDB(userId: string): Promise<VoiceCallRecord[]> {
  try {
    const rows = await db.select().from(voiceCalls)
      .where(and(
        or(eq(voiceCalls.callerId, userId), eq(voiceCalls.receiverId, userId)),
        inArray(voiceCalls.status, ['initiated', 'ringing', 'connected']),
      ))
      .orderBy(desc(voiceCalls.startedAt));

    return rows.map(toVoiceCallRecord);
  } catch (error) {
    console.error('❌ Exception getting active calls:', error);
    return [];
  }
}

export function setupVoiceCallHandlers(io: SocketIOServer, socket: Socket, userId: string) {

  // Start a voice call
  socket.on('voice:start-call', async (data: { receiverId: string; callType?: string }) => {
    try {
      // Check if receiver is already in an active call (busy)
      const existingReceiverCalls = await getActiveCallsFromDB(data.receiverId);
      if (existingReceiverCalls.length > 0) {
        console.warn('⚠️ Receiver is already in an active call, rejecting new call request');
        socket.emit('voice:error', {
          error: 'User is already on another call. Please wait until their current call ends.',
          reason: 'user_busy',
          receiverId: data.receiverId,
        });
        return;
      }

      // Optional: also prevent caller from starting multiple calls at once
      const existingCallerCalls = await getActiveCallsFromDB(userId);
      if (existingCallerCalls.length > 0) {
        console.warn('⚠️ Caller is already in an active call, rejecting new call request');
        socket.emit('voice:error', {
          error: 'You are already on another call. Please end it before starting a new one.',
          reason: 'caller_busy',
        });
        return;
      }

      // Check if users are friends (optional - you might want to allow calls to non-friends)
      // Accept both 'active' and 'accepted' status for compatibility
      const [friendship] = await db.select({ id: friendships.id }).from(friendships)
        .where(and(
          or(
            and(eq(friendships.user1Id, userId), eq(friendships.user2Id, data.receiverId)),
            and(eq(friendships.user1Id, data.receiverId), eq(friendships.user2Id, userId)),
          ),
          inArray(friendships.status, ['active', 'accepted']),
        ))
        .limit(1);

      if (!friendship) {
        console.warn('⚠️ No active friendship found between users');
        socket.emit('voice:error', { error: 'You can only call friends' });
        return;
      }


      // Get caller info from profiles table
      const [callerInfo] = await db.select({ first_name: profiles.firstName, last_name: profiles.lastName, profile_photo_url: profiles.profilePhotoUrl })
        .from(profiles).where(eq(profiles.id, userId)).limit(1);

      const callId = `call_${userId}_${data.receiverId}_${Date.now()}`;
      const callType = (data.callType as 'webrtc' | 'audio-fallback') || 'webrtc';
      
      
      // Create call record in database
      const callRecord = await createCallRecord(callId, userId, data.receiverId, callType);
      if (!callRecord) {
        console.error('❌ Failed to create call record for:', callId);
        socket.emit('voice:error', { error: 'Failed to create call record' });
        return;
      }
      

      // Update status to ringing
      await updateCallStatus(callId, 'ringing');

      // Notify the receiver
      const callerName = callerInfo ? `${callerInfo.first_name} ${callerInfo.last_name}` : 'Unknown';
      const callerAvatar = callerInfo?.profile_photo_url || '';
      
      const callData = {
        callId,
        callerId: userId,
        callerName,
        callerAvatar,
        callType
      };

      // Send push notification so call rings even if receiver app is closed/backgrounded
      try {
        const { PushNotificationService } = await import('../services/pushNotificationService.js');
        await PushNotificationService.sendVoiceCallNotification(
          data.receiverId,
          userId,
          callerName,
          callId
        );
      } catch (pushError) {
        console.error('❌ Failed to send voice call push notification:', pushError);
      }

      // Enhanced receiver connection check with multiple verification methods
      
      // Method 1: Check sockets in user room
      const receiverSockets = await io.in(data.receiverId).fetchSockets();
      
      // Method 2: Check all connected sockets for this user
      const allSockets = await io.fetchSockets();
      const userSockets = allSockets.filter(s => {
        const socketUserId = (s.data as any)?.userId || (s.data as any)?.user?.id;
        return socketUserId === data.receiverId;
      });
      
      // Method 3: Check socket rooms for debugging
      if (userSockets.length > 0) {
        const socketRooms = Array.from(userSockets[0].rooms);
      }
      
      // Use the more comprehensive check
      const effectiveReceiverSockets = userSockets.length > 0 ? userSockets : receiverSockets;
      
      if (effectiveReceiverSockets.length === 0) {
        console.warn('⚠️ Receiver is not connected to socket (verified by all methods)');
        // Do not mark as missed immediately; push notification will ring on device.
      } else {
        
        // Ensure receiver is in their user room (fix any room issues)
        for (const receiverSocket of userSockets) {
          if (!receiverSocket.rooms.has(data.receiverId)) {
            receiverSocket.join(data.receiverId);
          }
        }
      }
      
      // Send incoming call to receiver
      io.to(data.receiverId).emit('voice:incoming-call', callData);
      
      // Confirm to caller that call was sent
      socket.emit('voice:call-sent', { 
        callId, 
        message: 'Call sent to receiver',
        receiverOnline: true 
      });


    } catch (error) {
      console.error('❌ Error starting voice call:', error);
      socket.emit('voice:error', { error: 'Failed to start call' });
    }
  });

  // Accept a voice call
  socket.on('voice:accept-call', async (data: { callId: string; callType?: string }) => {
    try {
    
      // Get call from database
      const [callRow] = await db.select().from(voiceCalls).where(eq(voiceCalls.callId, data.callId)).limit(1);
      const call = callRow ? toVoiceCallRecord(callRow) : null;

      if (!call) {
        console.error('❌ Call not found in database:', {
          callId: data.callId,
          userId: userId
        });
        socket.emit('voice:error', { error: 'Call not found or expired' });
        return;
      }

      if (call.receiver_id !== userId) {
        socket.emit('voice:error', { error: 'Unauthorized to accept this call' });
        return;
      }

      // Update call status to connected
      const updated = await updateCallStatus(data.callId, 'connected');
      if (!updated) {
        socket.emit('voice:error', { error: 'Failed to update call status' });
        return;
      }

      // Notify both parties that call is accepted
      //console.log('🔍 BACKEND DEBUG: Emitting voice:call-accepted to caller:', call.caller_id);
      
      
      // Check if caller is connected
      const callerSockets = await io.in(call.caller_id).fetchSockets();
      //console.log('🔍 BACKEND DEBUG: Caller sockets found:', callerSockets.length);
      //console.log('🔍 BACKEND DEBUG: Caller socket IDs:', callerSockets.map((s: any) => s.id));
      
      io.to(call.caller_id).emit('voice:call-accepted', {
        callId: data.callId,
        acceptedBy: userId,
        callType: call.call_type
      });

      socket.emit('voice:call-accepted', {
        callId: data.callId,
        acceptedBy: userId,
        callType: call.call_type
      });


    } catch (error) {
      console.error('❌ Error accepting voice call:', error);
      console.error('🔍 BACKEND DEBUG: Call acceptance failed with error:', (error as Error).message);
      console.error('🔍 BACKEND DEBUG: Error stack:', (error as Error).stack);
      socket.emit('voice:error', { error: 'Failed to accept call' });
    }
  });

  // Decline a voice call (receiver declines OR caller cancels)
  socket.on('voice:decline-call', async (data: { callId: string }) => {
    try {

      // Get call from database
      const [declineCallRow] = await db.select().from(voiceCalls).where(eq(voiceCalls.callId, data.callId)).limit(1);
      const call = declineCallRow ? toVoiceCallRecord(declineCallRow) : null;

      if (!call) {
        socket.emit('voice:error', { error: 'Call not found' });
        return;
      }

      // Allow both caller (to cancel) and receiver (to decline)
      const isCaller = call.caller_id === userId;
      const isReceiver = call.receiver_id === userId;
      
      if (!isCaller && !isReceiver) {
        socket.emit('voice:error', { error: 'Unauthorized to decline this call' });
        return;
      }

      // Update call status to declined
      const endReason = isCaller ? 'cancelled' : 'declined';
      const updated = await updateCallStatus(data.callId, 'declined', endReason);
      if (!updated) {
        socket.emit('voice:error', { error: 'Failed to update call status' });
        return;
      }

      // Notify the other party
      if (isCaller) {
        // Caller cancelled - notify receiver
        io.to(call.receiver_id).emit('voice:call-declined', {
          callId: data.callId,
          declinedBy: userId,
          reason: 'cancelled'
        });
      } else {
        // Receiver declined - notify caller
        io.to(call.caller_id).emit('voice:call-declined', {
          callId: data.callId,
          declinedBy: userId,
          reason: 'declined'
        });
      }


    } catch (error) {
      console.error('❌ Error declining voice call:', error);
      socket.emit('voice:error', { error: 'Failed to decline call' });
    }
  });

  // End a voice call
  socket.on('voice:end-call', async (data: { callId: string; duration?: number }) => {
    try {

      // Get call from database
      const [endCallRow] = await db.select().from(voiceCalls).where(eq(voiceCalls.callId, data.callId)).limit(1);
      const call = endCallRow ? toVoiceCallRecord(endCallRow) : null;

      if (!call) {
        socket.emit('voice:error', { error: 'Call not found' });
        return;
      }

      if (call.caller_id !== userId && call.receiver_id !== userId) {
        socket.emit('voice:error', { error: 'Unauthorized to end this call' });
        return;
      }

      // Update call status to ended
      const updated = await updateCallStatus(data.callId, 'ended', 'completed');
      if (!updated) {
        socket.emit('voice:error', { error: 'Failed to update call status' });
        return;
      }

      // Notify the other party
      const otherUserId = call.caller_id === userId ? call.receiver_id : call.caller_id;
      io.to(otherUserId).emit('voice:call-ended', {
        callId: data.callId,
        endedBy: userId,
        duration: data.duration || 0
      });


    } catch (error) {
      console.error('❌ Error ending voice call:', error);
      socket.emit('voice:error', { error: 'Failed to end call' });
    }
  });

  // WebRTC signaling
  socket.on('voice:offer', async (data: { callId: string; offer: any }) => {
    try {
      //console.log('📨 WebRTC offer received:', data.callId, 'from user:', userId);
      
      const [call] = await db.select({ caller_id: voiceCalls.callerId, receiver_id: voiceCalls.receiverId })
        .from(voiceCalls).where(eq(voiceCalls.callId, data.callId)).limit(1);

      //console.log('📞 Call lookup for offer:', { call, callId: data.callId });

      if (call && call.caller_id === userId) {
        //console.log('📨 Forwarding offer to receiver:', call.receiver_id);
        io.to(call.receiver_id).emit('voice:offer', {
          callId: data.callId,
          offer: data.offer
        });
      } else {
        console.error('❌ Cannot forward offer - invalid caller or call not found');
      }
    } catch (error) {
      console.error('❌ Error handling voice offer:', error);
    }
  });

  socket.on('voice:answer', async (data: { callId: string; answer: any }) => {
    try {
      //console.log('📨 WebRTC answer received:', data.callId, 'from user:', userId);
      
      const [call] = await db.select({ caller_id: voiceCalls.callerId, receiver_id: voiceCalls.receiverId })
        .from(voiceCalls).where(eq(voiceCalls.callId, data.callId)).limit(1);

      if (call && call.receiver_id === userId) {
        io.to(call.caller_id).emit('voice:answer', {
          callId: data.callId,
          answer: data.answer
        });
      } else {
        console.error('❌ Cannot forward answer - invalid receiver or call not found');
      }
    } catch (error) {
      console.error('❌ Error handling voice answer:', error);
    }
  });

  socket.on('voice:ice-candidate', async (data: { callId: string; candidate: any }) => {
    try {
      
      const [call] = await db.select({ caller_id: voiceCalls.callerId, receiver_id: voiceCalls.receiverId })
        .from(voiceCalls).where(eq(voiceCalls.callId, data.callId)).limit(1);

      if (call) {
        const otherUserId = call.caller_id === userId ? call.receiver_id : call.caller_id;
        io.to(otherUserId).emit('voice:ice-candidate', {
          callId: data.callId,
          candidate: data.candidate
        });
      } else {
        console.error('❌ Cannot forward ICE candidate - call not found');
      }
    } catch (error) {
      console.error('❌ Error handling ICE candidate:', error);
    }
  });

  // Audio chunk for Expo Go fallback
  socket.on('voice:audio-chunk', async (data: { callId: string; audioUri: string; timestamp: number }) => {
    try {
      const [call] = await db.select({ caller_id: voiceCalls.callerId, receiver_id: voiceCalls.receiverId, status: voiceCalls.status })
        .from(voiceCalls).where(eq(voiceCalls.callId, data.callId)).limit(1);

      if (call && call.status === 'connected') {
        const otherUserId = call.caller_id === userId ? call.receiver_id : call.caller_id;
        io.to(otherUserId).emit('voice:audio-chunk', {
          callId: data.callId,
          audioUri: data.audioUri,
          timestamp: data.timestamp
        });
      }
    } catch (error) {
      console.error('❌ Error handling audio chunk:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    
    try {
      // End any active calls for this user
      const activeCalls = await getActiveCallsFromDB(userId);
      
      for (const call of activeCalls) {
        const otherUserId = call.caller_id === userId ? call.receiver_id : call.caller_id;
        
        // Notify the other user
        io.to(otherUserId).emit('voice:call-ended', {
          callId: call.call_id,
          endedBy: userId,
          reason: 'disconnected'
        });
        
        // Update call status to ended
        await updateCallStatus(call.call_id, 'ended', 'disconnected');
      }
    } catch (error) {
      console.error('❌ Error handling disconnect cleanup:', error);
    }
  });
}

// Helper function to get all active calls (for debugging)
export async function getAllActiveCalls(): Promise<VoiceCallRecord[]> {
  try {
    const rows = await db.select().from(voiceCalls)
      .where(inArray(voiceCalls.status, ['initiated', 'ringing', 'connected']))
      .orderBy(desc(voiceCalls.startedAt));

    return rows.map(toVoiceCallRecord);
  } catch (error) {
    console.error('❌ Exception getting all active calls:', error);
    return [];
  }
}

// Helper function to clean up old calls from database
export async function cleanupOldCalls(): Promise<number> {
  try {
    // End calls that have been active for more than 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const rows = await db.update(voiceCalls).set({
      status: 'ended',
      endReason: 'timeout',
      endedAt: new Date().toISOString(),
    })
      .where(and(
        inArray(voiceCalls.status, ['initiated', 'ringing', 'connected']),
        lt(voiceCalls.startedAt, twoHoursAgo),
      ))
      .returning({ callId: voiceCalls.callId });

    const cleanedCount = rows?.length || 0;

    return cleanedCount;
  } catch (error) {
    console.error('❌ Exception cleaning up old calls:', error);
    return 0;
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldCalls, 30 * 60 * 1000);

// Test handler to debug user room subscription
export function registerTestHandlers(io: SocketIOServer, socket: Socket) {
  const userId = (socket.data as any).user?.id;
  
  // Test user room subscription
  socket.on('test:user-room', async (data) => {
    
    if (userId) {
      // Check if user is in their own room
      const userSockets = await io.in(userId).fetchSockets();
  
      
      // Test emitting to the user's room
      io.to(userId).emit('voice:test', {
        message: 'Test voice event',
        timestamp: Date.now(),
        fromUserId: userId
      });
      
      // Also emit test user event
      io.to(userId).emit('test:user:event', {
        message: 'User room test successful',
        userId: userId,
        socketId: socket.id
      });
    }
  });
  
  // Debug handler to check socket authentication and room membership
  socket.on('debug:socket-info', async (data) => {
    
    // Check socket authentication
    const socketUserId = (socket.data as any).user?.id;
    const socketAuth = (socket.data as any).user;
    
   
    
    // Check room membership
    if (socketUserId) {
      const userSockets = await io.in(socketUserId).fetchSockets();
      
      
      // Try to manually join the room if not already joined
      if (!userSockets.some((s: any) => s.id === socket.id)) {
        try {
          socket.join(socketUserId);
        } catch (error) {
          console.error('❌ DEBUG: Failed to join user room:', error);
        }
      }
    } else {
      console.error('❌ DEBUG: No authenticated user ID found on socket');
    }
  });
  
  // Test handler to verify events are reaching backend
  socket.on('test:backend-connection', (data) => {
    socket.emit('test:backend-response', {
      message: 'Backend received your test event',
      userId: userId,
      timestamp: Date.now()
    });
  });
  
  // Keep-alive handler during voice calls
  socket.on('voice:keep-alive', (data) => {
    // Respond with pong to confirm connection
    socket.emit('voice:keep-alive-pong', {
      callId: data.callId,
      timestamp: Date.now()
    });
  });
}
