import { Router, Response } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { supabase } from '../config/supabase.js';
import axios from 'axios';
import FormData from 'form-data';
import multer from 'multer';
import { NotificationService } from '../services/notificationService.js';

const router = Router();

// Configure multer for video upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

const PYTHON_SERVICE_URL = process.env.PYTHON_VERIFICATION_URL || 'http://localhost:5000';

// Get user's verification status
router.get('/status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Get profile verification status
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('verification_status, verified_at, verification_required')
      .eq('id', userId)
      .single();

    if (profileError) {
      console.error('Error fetching profile:', profileError);
      return res.status(500).json({ error: 'Failed to fetch verification status' });
    }

    // Get latest verification attempt
    const { data: latestVerification } = await supabase
      .from('face_verifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return res.json({
      status: profile.verification_status,
      verified_at: profile.verified_at,
      required: profile.verification_required,
      latest_attempt: latestVerification
    });
  } catch (error) {
    console.error('Error getting verification status:', error);
    return res.status(500).json({ error: 'Failed to get verification status' });
  }
});

// Submit video for verification
router.post('/submit', requireAuth, upload.single('video'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (!req.file) {
      return res.status(400).json({ error: 'Video file is required' });
    }

    // Check if user already verified
    const { data: profile } = await supabase
      .from('profiles')
      .select('verification_status')
      .eq('id', userId)
      .single();

    if (profile?.verification_status === 'verified') {
      return res.status(400).json({ error: 'User already verified' });
    }

    // Log attempt
    await supabase.from('verification_attempts').insert({
      user_id: userId,
      success: false,
      ip_address: req.ip,
      user_agent: req.get('User-Agent'),
      device_info: req.body.device_info ? JSON.parse(req.body.device_info) : null
    });

    // Prepare form data for Python service
    const formData = new FormData();
    formData.append('video', req.file.buffer, {
      filename: `${userId}_${Date.now()}.mp4`,
      contentType: req.file.mimetype
    });
    formData.append('user_id', userId);

    // Call Python verification service
    console.log('📹 Sending video to verification service...');
    const pythonResponse = await axios.post(
      `${PYTHON_SERVICE_URL}/verify`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 60000 // 60 second timeout
      }
    );

    const verificationResult = pythonResponse.data;
    console.log('✅ Verification result:', verificationResult);

    // Create verification record
    const { data: verification, error: insertError } = await supabase
      .from('face_verifications')
      .insert({
        user_id: userId,
        status: verificationResult.verified ? 'verified' : 'rejected',
        video_s3_key: verificationResult.video_s3_key || null,
        verification_data: verificationResult,
        confidence: verificationResult.confidence,
        movements_detected: verificationResult.movements_detected,
        verified_at: verificationResult.verified ? new Date().toISOString() : null,
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
        device_info: req.body.device_info ? JSON.parse(req.body.device_info) : null
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating verification record:', insertError);
      return res.status(500).json({ error: 'Failed to save verification' });
    }

    // Update attempt log
    await supabase
      .from('verification_attempts')
      .update({
        success: verificationResult.verified,
        failure_reason: verificationResult.reason,
        verification_id: verification.id
      })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    // Send notification if verified
    if (verificationResult.verified) {
      try {
        await NotificationService.notifyVerificationSuccess(userId);
      } catch (notifError) {
        console.error('Failed to send verification notification:', notifError);
      }
    }

    return res.json({
      success: verificationResult.verified,
      verification_id: verification.id,
      status: verification.status,
      confidence: verificationResult.confidence,
      reason: verificationResult.reason,
      movements_detected: verificationResult.movements_detected,
      movements_required: verificationResult.movements_required
    });

  } catch (error: any) {
    console.error('Error during verification:', error);
    
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Verification service unavailable',
        details: 'Please try again later'
      });
    }

    return res.status(500).json({ 
      error: 'Verification failed',
      details: error.message 
    });
  }
});

// Get verification history
router.get('/history', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
      .from('face_verifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching verification history:', error);
      return res.status(500).json({ error: 'Failed to fetch history' });
    }

    return res.json({ verifications: data });
  } catch (error) {
    console.error('Error getting verification history:', error);
    return res.status(500).json({ error: 'Failed to get history' });
  }
});

// Admin: Get pending verifications
router.get('/admin/pending', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Check if user is admin
    const { data: adminCheck } = await supabase
      .from('admins')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!adminCheck) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { data, error } = await supabase
      .from('face_verifications')
      .select(`
        *,
        user:profiles!user_id(id, first_name, last_name, email, username)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching pending verifications:', error);
      return res.status(500).json({ error: 'Failed to fetch verifications' });
    }

    return res.json({ verifications: data });
  } catch (error) {
    console.error('Error getting pending verifications:', error);
    return res.status(500).json({ error: 'Failed to get verifications' });
  }
});

// Admin: Approve/Reject verification
router.post('/admin/:id/review', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const verificationId = req.params.id;
    const { action, notes } = req.body; // action: 'approve' | 'reject'

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Check if user is admin
    const { data: adminCheck } = await supabase
      .from('admins')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!adminCheck) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    // Update verification
    const { data: verification, error } = await supabase
      .from('face_verifications')
      .update({
        status: action === 'approve' ? 'verified' : 'rejected',
        reviewed_by: userId,
        review_notes: notes,
        reviewed_at: new Date().toISOString(),
        verified_at: action === 'approve' ? new Date().toISOString() : null
      })
      .eq('id', verificationId)
      .select()
      .single();

    if (error) {
      console.error('Error updating verification:', error);
      return res.status(500).json({ error: 'Failed to update verification' });
    }

    // If approved and video exists, delete it
    if (action === 'approve' && verification.video_s3_key) {
      try {
        await axios.post(`${PYTHON_SERVICE_URL}/delete-video`, {
          s3_key: verification.video_s3_key
        });
      } catch (deleteError) {
        console.error('Failed to delete video:', deleteError);
      }
    }

    // Send notification
    try {
      if (action === 'approve') {
        await NotificationService.notifyVerificationSuccess(verification.user_id);
      } else {
        await NotificationService.notifyVerificationRejected(
          verification.user_id,
          notes || 'Verification failed. Please try again.'
        );
      }
    } catch (notifError) {
      console.error('Failed to send notification:', notifError);
    }

    return res.json({
      success: true,
      verification
    });

  } catch (error) {
    console.error('Error reviewing verification:', error);
    return res.status(500).json({ error: 'Failed to review verification' });
  }
});

export default router;
