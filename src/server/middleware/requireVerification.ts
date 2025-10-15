import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.js';
import { supabase } from '../config/supabase.js';

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
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('verification_status, verification_required')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Error checking verification status:', error);
      return res.status(500).json({ error: 'Failed to check verification status' });
    }

    // If verification not required, allow access
    if (!profile.verification_required) {
      return next();
    }

    // Check if user is verified
    if (profile.verification_status === 'verified') {
      return next();
    }

    // User not verified - block access
    return res.status(403).json({
      error: 'Verification required',
      message: 'Please complete face verification to access this feature',
      verification_status: profile.verification_status,
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
      const { data: profile } = await supabase
        .from('profiles')
        .select('verification_status, verification_required')
        .eq('id', userId)
        .single();

      if (profile) {
        req.verificationStatus = profile.verification_status;
        req.verificationRequired = profile.verification_required;
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
