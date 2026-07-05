import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { AuthRequest } from './auth.js';
import { db } from '../config/db.js';
import { profiles } from '../db/schema.js';

/**
 * Middleware to require face verification
 * Blocks access to protected routes until user is verified
 */
export async function requireVerification(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get user's verification status
    const rows = await db.select({
      verificationStatus: profiles.verificationStatus,
      verificationRequired: profiles.verificationRequired,
    }).from(profiles).where(eq(profiles.id, userId)).limit(1);
    const profile = rows[0];

    if (!profile) {
      console.error('Error checking verification status: profile not found for user', userId);
      return res.status(500).json({ error: 'Failed to check verification status' });
    }

    // If verification not required, allow access
    if (!profile.verificationRequired) {
      return next();
    }

    // Check if user is verified
    if (profile.verificationStatus === 'verified') {
      return next();
    }

    // User not verified - block access
    return res.status(403).json({
      error: 'Verification required',
      message: 'Please complete face verification to access this feature',
      verification_status: profile.verificationStatus,
      verification_required: true
    });

  } catch (error) {
    console.error('Error in requireVerification middleware:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Optional verification check - doesn't block but adds verification info to request
 */
export async function checkVerification(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user?.id;

    if (userId) {
      const rows = await db.select({
        verificationStatus: profiles.verificationStatus,
        verificationRequired: profiles.verificationRequired,
      }).from(profiles).where(eq(profiles.id, userId)).limit(1);
      const profile = rows[0];

      if (profile) {
        req.verificationStatus = profile.verificationStatus ?? undefined;
        req.verificationRequired = profile.verificationRequired ?? undefined;
      }
    }

    next();
  } catch (error) {
    console.error('Error in checkVerification middleware:', error);
    next(); // Don't block on error
  }
}

// Extend AuthRequest type
declare module './auth.js' {
  interface AuthRequest {
    verificationStatus?: string;
    verificationRequired?: boolean;
  }
}
