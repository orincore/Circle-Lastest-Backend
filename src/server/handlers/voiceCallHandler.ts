import { Server as SocketIOServer, Socket } from 'socket.io';
import { supabase } from '../config/supabase.js';

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

// Helper function to create call record in database
async function createCallRecord(callId: string, callerId: string, receiverId: string, callType: 'webrtc' | 'audio-fallback'): Promise<VoiceCallRecord | null> {
  try {
    console.log('📝 Creating call record:', { callId, callerId, receiverId, callType });
    
    const { data, error } = await supabase
      .from('voice_calls')
      .insert({
        call_id: callId,
        caller_id: callerId,
        receiver_id: receiverId,
        call_type: callType,
        status: 'initiated'
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating call record:', error);
      return null;
    }

    console.log('✅ Call record created successfully:', data);
    return data;
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
      updateData.connected_at = new Date().toISOString();
    } else if (status === 'ended' || status === 'declined' || status === 'missed') {
      updateData.ended_at = new Date().toISOString();
      if (endReason) {
        updateData.end_reason = endReason;
      }
    }

    const { error } = await supabase
      .from('voice_calls')
      .update(updateData)
      .eq('call_id', callId);

    if (error) {
      console.error('❌ Error updating call status:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('❌ Exception updating call status:', error);
    return false;
  }
}

// Helper function to get active calls from database
async function getActiveCallsFromDB(userId: string): Promise<VoiceCallRecord[]> {
  try {
    const { data, error } = await supabase
      .from('voice_calls')
      .select('*')
      .or(`caller_id.eq.${userId},receiver_id.eq.${userId}`)
      .in('status', ['initiated', 'ringing', 'connected'])
      .order('started_at', { ascending: false });

    if (error) {
      console.error('❌ Error getting active calls:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('❌ Exception getting active calls:', error);
    return [];
  }
}

export function setupVoiceCallHandlers(io: SocketIOServer, socket: Socket, userId: string) {
  console.log('🎙️ Setting up voice call handlers for user:', userId);

  // Start a voice call
  socket.on('voice:start-call', async (data: { receiverId: string; callType?: string }) => {
    try {
      console.log('📞 Voice call started by:', userId, 'to:', data.receiverId);

      // Check if users are friends (optional - you might want to allow calls to non-friends)
      const { data: friendship } = await supabase
        .from('friendships')
        .select('id')
        .or(`and(user1_id.eq.${userId},user2_id.eq.${data.receiverId}),and(user1_id.eq.${data.receiverId},user2_id.eq.${userId})`)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();

      if (!friendship) {
        socket.emit('voice:error', { error: 'You can only call friends' });
        return;
      }

      // Get caller info from profiles table
      const { data: callerInfo } = await supabase
        .from('profiles')
        .select('first_name, last_name, profile_photo_url')
        .eq('id', userId)
        .single();

      const callId = `call_${userId}_${data.receiverId}_${Date.now()}`;
      const callType = (data.callType as 'webrtc' | 'audio-fallback') || 'webrtc';
      
      console.log('📞 Generated call ID:', callId);
      console.log('📞 Call type:', callType);
      
      // Create call record in database
      const callRecord = await createCallRecord(callId, userId, data.receiverId, callType);
      if (!callRecord) {
        console.error('❌ Failed to create call record for:', callId);
        socket.emit('voice:error', { error: 'Failed to create call record' });
        return;
      }
      
      console.log('✅ Call record created, proceeding with call setup');

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

      console.log('📞 Emitting voice:incoming-call to receiver:', data.receiverId);
      console.log('📞 Call data being sent:', callData);
      
      // Check if receiver is connected
      const receiverSockets = await io.in(data.receiverId).fetchSockets();
      console.log('📞 Receiver sockets found:', receiverSockets.length);
      if (receiverSockets.length === 0) {
        console.warn('⚠️ Receiver is not connected to socket');
      } else {
        console.log('📞 Receiver socket IDs:', receiverSockets.map(s => s.id));
      }
      
      io.to(data.receiverId).emit('voice:incoming-call', callData);

      console.log('✅ Voice call initiated and notification sent:', callId);

    } catch (error) {
      console.error('❌ Error starting voice call:', error);
      socket.emit('voice:error', { error: 'Failed to start call' });
    }
  });

  // Accept a voice call
  socket.on('voice:accept-call', async (data: { callId: string; callType?: string }) => {
    try {
      console.log('✅ Voice call accepted:', data.callId, 'by:', userId);
      console.log('🔍 BACKEND DEBUG: Received voice:accept-call event');
      console.log('🔍 BACKEND DEBUG: Event data:', data);
      console.log('🔍 BACKEND DEBUG: Socket user ID:', userId);

      // Get call from database
      console.log('🔍 Looking for call in database:', data.callId);
      const { data: call, error } = await supabase
        .from('voice_calls')
        .select('*')
        .eq('call_id', data.callId)
        .single();

      console.log('📞 Database query result:', { call, error });

      if (error || !call) {
        console.error('❌ Call not found in database:', {
          callId: data.callId,
          error: error?.message,
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
      console.log('🔍 BACKEND DEBUG: Emitting voice:call-accepted to caller:', call.caller_id);
      console.log('🔍 BACKEND DEBUG: Call acceptance data:', {
        callId: data.callId,
        acceptedBy: userId,
        callType: call.call_type
      });
      
      // Check if caller is connected
      const callerSockets = await io.in(call.caller_id).fetchSockets();
      console.log('🔍 BACKEND DEBUG: Caller sockets found:', callerSockets.length);
      console.log('🔍 BACKEND DEBUG: Caller socket IDs:', callerSockets.map((s: any) => s.id));
      
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

      console.log('✅ Voice call connected:', data.callId);
      console.log('🔍 BACKEND DEBUG: Call acceptance completed successfully');

    } catch (error) {
      console.error('❌ Error accepting voice call:', error);
      console.error('🔍 BACKEND DEBUG: Call acceptance failed with error:', (error as Error).message);
      console.error('🔍 BACKEND DEBUG: Error stack:', (error as Error).stack);
      socket.emit('voice:error', { error: 'Failed to accept call' });
    }
  });

  // Decline a voice call
  socket.on('voice:decline-call', async (data: { callId: string }) => {
    try {
      console.log('❌ Voice call declined:', data.callId, 'by:', userId);

      // Get call from database
      const { data: call, error } = await supabase
        .from('voice_calls')
        .select('*')
        .eq('call_id', data.callId)
        .single();

      if (error || !call) {
        socket.emit('voice:error', { error: 'Call not found' });
        return;
      }

      if (call.receiver_id !== userId) {
        socket.emit('voice:error', { error: 'Unauthorized to decline this call' });
        return;
      }

      // Update call status to declined
      const updated = await updateCallStatus(data.callId, 'declined', 'declined');
      if (!updated) {
        socket.emit('voice:error', { error: 'Failed to update call status' });
        return;
      }

      // Notify caller that call was declined
      io.to(call.caller_id).emit('voice:call-declined', {
        callId: data.callId,
        declinedBy: userId
      });

      console.log('❌ Voice call declined:', data.callId);

    } catch (error) {
      console.error('❌ Error declining voice call:', error);
      socket.emit('voice:error', { error: 'Failed to decline call' });
    }
  });

  // End a voice call
  socket.on('voice:end-call', async (data: { callId: string; duration?: number }) => {
    try {
      console.log('📞 Voice call ended:', data.callId, 'by:', userId);

      // Get call from database
      const { data: call, error } = await supabase
        .from('voice_calls')
        .select('*')
        .eq('call_id', data.callId)
        .single();

      if (error || !call) {
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

      console.log('📞 Voice call ended:', data.callId);

    } catch (error) {
      console.error('❌ Error ending voice call:', error);
      socket.emit('voice:error', { error: 'Failed to end call' });
    }
  });

  // WebRTC signaling
  socket.on('voice:offer', async (data: { callId: string; offer: any }) => {
    try {
      console.log('📨 WebRTC offer received:', data.callId, 'from user:', userId);
      
      const { data: call, error } = await supabase
        .from('voice_calls')
        .select('caller_id, receiver_id')
        .eq('call_id', data.callId)
        .single();

      console.log('📞 Call lookup for offer:', { call, error, callId: data.callId });

      if (call && call.caller_id === userId) {
        console.log('📨 Forwarding offer to receiver:', call.receiver_id);
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
      console.log('📨 WebRTC answer received:', data.callId, 'from user:', userId);
      
      const { data: call, error } = await supabase
        .from('voice_calls')
        .select('caller_id, receiver_id')
        .eq('call_id', data.callId)
        .single();

      console.log('📞 Call lookup for answer:', { call, error, callId: data.callId });

      if (call && call.receiver_id === userId) {
        console.log('📨 Forwarding answer to caller:', call.caller_id);
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
      console.log('📡 ICE candidate received:', data.callId, 'from user:', userId);
      
      const { data: call, error } = await supabase
        .from('voice_calls')
        .select('caller_id, receiver_id')
        .eq('call_id', data.callId)
        .single();

      console.log('📞 Call lookup for ICE candidate:', { call, error, callId: data.callId });

      if (call) {
        const otherUserId = call.caller_id === userId ? call.receiver_id : call.caller_id;
        console.log('📡 Forwarding ICE candidate to:', otherUserId);
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
      const { data: call } = await supabase
        .from('voice_calls')
        .select('caller_id, receiver_id, status')
        .eq('call_id', data.callId)
        .single();

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
    console.log('🔌 User disconnected during voice call:', userId);
    
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
    const { data, error } = await supabase
      .from('voice_calls')
      .select('*')
      .in('status', ['initiated', 'ringing', 'connected'])
      .order('started_at', { ascending: false });

    if (error) {
      console.error('❌ Error getting all active calls:', error);
      return [];
    }

    return data || [];
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
    
    const { data, error } = await supabase
      .from('voice_calls')
      .update({ 
        status: 'ended', 
        end_reason: 'timeout',
        ended_at: new Date().toISOString()
      })
      .in('status', ['initiated', 'ringing', 'connected'])
      .lt('started_at', twoHoursAgo)
      .select('call_id');

    if (error) {
      console.error('❌ Error cleaning up old calls:', error);
      return 0;
    }

    const cleanedCount = data?.length || 0;
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} old calls`);
    }

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
    console.log('🧪 Test user room event from:', userId, 'data:', data);
    
    if (userId) {
      // Check if user is in their own room
      const userSockets = await io.in(userId).fetchSockets();
      console.log('🧪 User sockets in room', userId, ':', userSockets.length);
      console.log('🧪 Socket IDs:', userSockets.map((s: any) => s.id));
      console.log('🧪 Current socket ID:', socket.id);
      
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
    console.log('🔍 DEBUG: Socket info request from:', userId, 'data:', data);
    
    // Check socket authentication
    const socketUserId = (socket.data as any).user?.id;
    const socketAuth = (socket.data as any).user;
    
    console.log('🔍 DEBUG: Socket authentication details:', {
      socketId: socket.id,
      authenticatedUserId: socketUserId,
      requestedUserId: data.requestedUserId,
      userIdMatch: socketUserId === data.requestedUserId,
      hasUserData: !!socketAuth,
      userDataKeys: socketAuth ? Object.keys(socketAuth) : []
    });
    
    // Check room membership
    if (socketUserId) {
      const userSockets = await io.in(socketUserId).fetchSockets();
      console.log('🔍 DEBUG: Room membership check:', {
        userId: socketUserId,
        socketsInRoom: userSockets.length,
        socketIds: userSockets.map((s: any) => s.id),
        currentSocketInRoom: userSockets.some((s: any) => s.id === socket.id)
      });
      
      // Try to manually join the room if not already joined
      if (!userSockets.some((s: any) => s.id === socket.id)) {
        console.log('🔍 DEBUG: Socket not in user room, attempting to join...');
        try {
          socket.join(socketUserId);
          console.log('✅ DEBUG: Successfully joined user room:', socketUserId);
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
    console.log('🧪 TEST: Backend received test event from:', userId, 'data:', data);
    socket.emit('test:backend-response', {
      message: 'Backend received your test event',
      userId: userId,
      timestamp: Date.now()
    });
  });
  
  // Keep-alive handler during voice calls
  socket.on('voice:keep-alive', (data) => {
    console.log('💓 KEEP-ALIVE: Voice call ping from:', userId, 'duration:', data.duration + 's');
    // Respond with pong to confirm connection
    socket.emit('voice:keep-alive-pong', {
      callId: data.callId,
      timestamp: Date.now()
    });
  });
}
