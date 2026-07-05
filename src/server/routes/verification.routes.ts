import { Router, Response } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { desc, eq } from 'drizzle-orm';
import { db } from '../config/db.js';
import { adminRoles, faceVerifications, profiles, verificationAttempts } from '../db/schema.js';
import axios from 'axios';
import FormData from 'form-data';
import multer from 'multer';
import { NotificationService } from '../services/notificationService.js';

const router = Router();

// Column selection mapping faceVerifications' camelCase Drizzle fields back to
// the snake_case shape the frontend has always consumed from this file.
const faceVerificationColumns = {
  id: faceVerifications.id,
  user_id: faceVerifications.userId,
  status: faceVerifications.status,
  video_s3_key: faceVerifications.videoS3Key,
  verification_data: faceVerifications.verificationData,
  confidence: faceVerifications.confidence,
  movements_detected: faceVerifications.movementsDetected,
  submitted_at: faceVerifications.submittedAt,
  verified_at: faceVerifications.verifiedAt,
  expires_at: faceVerifications.expiresAt,
  reviewed_by: faceVerifications.reviewedBy,
  review_notes: faceVerifications.reviewNotes,
  reviewed_at: faceVerifications.reviewedAt,
  created_at: faceVerifications.createdAt,
  updated_at: faceVerifications.updatedAt,
}

// Configure multer for video upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'];
    if (file.mimetype.startsWith('video/') || allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed (mp4, webm, mov, avi)'));
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
    let profile
    try {
      [profile] = await db.select({
        verification_status: profiles.verificationStatus,
        verified_at: profiles.verifiedAt,
        verification_required: profiles.verificationRequired,
      }).from(profiles).where(eq(profiles.id, userId)).limit(1);
    } catch (profileError) {
      console.error('Error fetching profile:', profileError);
      return res.status(500).json({ error: 'Failed to fetch verification status' });
    }

    // Get latest verification attempt
    const [latestVerification] = await db.select(faceVerificationColumns).from(faceVerifications).where(eq(faceVerifications.userId, userId)).orderBy(desc(faceVerifications.createdAt)).limit(1);

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
    const [profile] = await db.select({ verification_status: profiles.verificationStatus }).from(profiles).where(eq(profiles.id, userId)).limit(1);

    if (profile?.verification_status === 'verified') {
      return res.status(400).json({ error: 'User already verified' });
    }

    // Validate video file size (minimum check)
    const minFileSize = 100 * 1024; // 100KB minimum
    if (req.file.size < minFileSize) {
      return res.status(400).json({
        error: 'Video file too small',
        reason: 'Video appears to be corrupted or too short. Please record at least 5 seconds.'
      });
    }

    // Log attempt
    const [attempt] = await db.insert(verificationAttempts).values({
      userId,
      success: false,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      deviceInfo: req.body.device_info ? JSON.parse(req.body.device_info) : null,
    }).returning({ id: verificationAttempts.id });

    // Prepare form data for Python service
    const formData = new FormData();
    formData.append('video', req.file.buffer, {
      filename: `${userId}_${Date.now()}.mp4`,
      contentType: req.file.mimetype
    });
    formData.append('user_id', userId);
    
    // Add flag to skip duration check on Python side for browser-recorded videos
    // Browser MediaRecorder may not set proper duration metadata
    const userAgent = req.get('User-Agent') || '';
    const isMobileBrowser = /Mobile|Android|iPhone|iPad/i.test(userAgent) && !/Electron/i.test(userAgent);
    if (isMobileBrowser) {
      formData.append('skip_duration_check', 'true');
      console.log('📱 Mobile browser detected, skipping strict duration validation');
    }

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
    let verification
    try {
      [verification] = await db.insert(faceVerifications).values({
        userId,
        status: verificationResult.verified ? 'verified' : 'rejected',
        videoS3Key: verificationResult.video_s3_key || null,
        verificationData: verificationResult,
        confidence: verificationResult.confidence,
        movementsDetected: verificationResult.movements_detected,
        verifiedAt: verificationResult.verified ? new Date().toISOString() : null,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        deviceInfo: req.body.device_info ? JSON.parse(req.body.device_info) : null,
      }).returning();
    } catch (insertError) {
      console.error('Error creating verification record:', insertError);
      return res.status(500).json({ error: 'Failed to save verification' });
    }

    // Update attempt log (the row logged just above, by id — order/limit on an
    // update has no effect via the DB driver, so target the specific row instead)
    if (attempt) {
      await db.update(verificationAttempts).set({
        success: verificationResult.verified,
        failureReason: verificationResult.reason,
        verificationId: verification.id,
      }).where(eq(verificationAttempts.id, attempt.id));
    }

    // Update profile verification status
    if (verificationResult.verified) {
      try {
        await db.update(profiles).set({
          verificationStatus: 'verified',
          verifiedAt: new Date().toISOString(),
          verificationRequired: false,
        }).where(eq(profiles.id, userId));
        console.log('✅ Profile verification status updated for user:', userId);
      } catch (updateError) {
        console.error('Error updating profile verification status:', updateError);
      }

      // Send notification if verified
      try {
        await NotificationService.notifyVerificationSuccess(userId);
      } catch (notifError) {
        console.error('Failed to send verification notification:', notifError);
      }
    } else {
      // Update profile to rejected status
      await db.update(profiles).set({ verificationStatus: 'rejected' }).where(eq(profiles.id, userId));
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

    const data = await db.select(faceVerificationColumns).from(faceVerifications).where(eq(faceVerifications.userId, userId)).orderBy(desc(faceVerifications.createdAt));

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

    // Check if user is admin (admin_roles table — `admins` has no backing table in this schema)
    const [adminCheck] = await db.select({ id: adminRoles.id }).from(adminRoles).where(eq(adminRoles.userId, userId)).limit(1);

    if (!adminCheck) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const rows = await db.select({
      ...faceVerificationColumns,
      user: {
        id: profiles.id,
        first_name: profiles.firstName,
        last_name: profiles.lastName,
        email: profiles.email,
        username: profiles.username,
      },
    })
      .from(faceVerifications)
      .leftJoin(profiles, eq(profiles.id, faceVerifications.userId))
      .where(eq(faceVerifications.status, 'pending'))
      .orderBy(desc(faceVerifications.createdAt));

    return res.json({ verifications: rows });
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

    // Check if user is admin (admin_roles table — `admins` has no backing table in this schema)
    const [adminCheck] = await db.select({ id: adminRoles.id }).from(adminRoles).where(eq(adminRoles.userId, userId)).limit(1);

    if (!adminCheck) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    // Update verification
    let verification
    try {
      [verification] = await db.update(faceVerifications).set({
        status: action === 'approve' ? 'verified' : 'rejected',
        reviewedBy: userId,
        reviewNotes: notes,
        reviewedAt: new Date().toISOString(),
        verifiedAt: action === 'approve' ? new Date().toISOString() : null,
      }).where(eq(faceVerifications.id, verificationId)).returning();
    } catch (error) {
      console.error('Error updating verification:', error);
      return res.status(500).json({ error: 'Failed to update verification' });
    }

    if (!verification) {
      return res.status(404).json({ error: 'Verification not found' });
    }

    // If approved and video exists, delete it
    if (action === 'approve' && verification.videoS3Key) {
      try {
        await axios.post(`${PYTHON_SERVICE_URL}/delete-video`, {
          s3_key: verification.videoS3Key
        });
      } catch (deleteError) {
        console.error('Failed to delete video:', deleteError);
      }
    }

    // Send notification
    try {
      if (action === 'approve') {
        await NotificationService.notifyVerificationSuccess(verification.userId);
      } else {
        await NotificationService.notifyVerificationRejected(
          verification.userId,
          notes || 'Verification failed. Please try again.'
        );
      }
    } catch (notifError) {
      console.error('Failed to send notification:', notifError);
    }

    return res.json({
      success: true,
      verification: {
        id: verification.id,
        user_id: verification.userId,
        status: verification.status,
        video_s3_key: verification.videoS3Key,
        verification_data: verification.verificationData,
        confidence: verification.confidence,
        movements_detected: verification.movementsDetected,
        submitted_at: verification.submittedAt,
        verified_at: verification.verifiedAt,
        expires_at: verification.expiresAt,
        reviewed_by: verification.reviewedBy,
        review_notes: verification.reviewNotes,
        reviewed_at: verification.reviewedAt,
        created_at: verification.createdAt,
        updated_at: verification.updatedAt,
      }
    });

  } catch (error) {
    console.error('Error reviewing verification:', error);
    return res.status(500).json({ error: 'Failed to review verification' });
  }
});

export default router;
