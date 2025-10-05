/**
 * Admin Authentication Middleware
 * Protects admin routes and enforces role-based access control
 */

import { Request, Response, NextFunction } from 'express'
import { supabase } from '../config/supabase.js'

// Extend Express Request to include admin info
export interface AdminRequest extends Request {
  user?: {
    id: string
    email?: string
  }
  admin?: {
    id: string
    role: 'super_admin' | 'moderator' | 'support'
    grantedAt: string
  }
}

/**
 * Middleware to check if user is an admin
 * Requires the user to be authenticated first (use requireAuth before this)
 */
export const requireAdmin = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // Check if user is authenticated
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      })
    }

    const userId = req.user.id

    // Check if user has admin role
    const { data: adminRole, error } = await supabase
      .from('admin_roles')
      .select('id, role, granted_at, is_active')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null)
      .single()

    if (error || !adminRole) {
      // Log unauthorized access attempt
      await logAdminAction(userId, 'unauthorized_access_attempt', 'admin_panel', null, {
        ip: req.ip,
        userAgent: req.get('user-agent')
      })

      return res.status(403).json({
        error: 'Forbidden',
        message: 'Admin access required'
      })
    }

    // Attach admin info to request
    req.admin = {
      id: adminRole.id,
      role: adminRole.role,
      grantedAt: adminRole.granted_at
    }

    // Log admin access
    await logAdminAction(userId, 'admin_access', 'admin_panel', null, {
      route: req.path,
      method: req.method
    })

    next()
  } catch (error) {
    console.error('Admin auth middleware error:', error)
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify admin status'
    })
  }
}

/**
 * Middleware to check if user has specific admin role
 * @param allowedRoles - Array of roles that can access the route
 */
export const requireRole = (allowedRoles: Array<'super_admin' | 'moderator' | 'support'>) => {
  return async (req: AdminRequest, res: Response, next: NextFunction) => {
    try {
      // Check if admin middleware has already run
      if (!req.admin) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Admin authentication required'
        })
      }

      // Check if admin has required role
      if (!allowedRoles.includes(req.admin.role)) {
        // Log unauthorized role access attempt
        await logAdminAction(req.user!.id, 'unauthorized_role_access', 'admin_panel', null, {
          requiredRoles: allowedRoles,
          userRole: req.admin.role,
          route: req.path
        })

        return res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient permissions. Required roles: ${allowedRoles.join(', ')}`
        })
      }

      next()
    } catch (error) {
      console.error('Role check middleware error:', error)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to verify role permissions'
      })
    }
  }
}

/**
 * Helper function to log admin actions
 */
export const logAdminAction = async (
  adminId: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  details: any = {}
) => {
  try {
    const { error } = await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: adminId,
        action,
        target_type: targetType,
        target_id: targetId,
        details,
        ip_address: details.ip || null,
        user_agent: details.userAgent || null
      })

    if (error) {
      console.error('Failed to log admin action:', error)
    }
  } catch (error) {
    console.error('Error logging admin action:', error)
  }
}

/**
 * Middleware to check if user is a super admin
 * Shorthand for requireRole(['super_admin'])
 */
export const requireSuperAdmin = requireRole(['super_admin'])

/**
 * Middleware to check if user is a moderator or higher
 */
export const requireModerator = requireRole(['super_admin', 'moderator'])

/**
 * Middleware to check if user has any admin role (including support)
 */
export const requireAnyAdmin = requireRole(['super_admin', 'moderator', 'support'])

/**
 * Helper function to check if a user is an admin (without middleware)
 * Useful for conditional logic in routes
 */
export const isAdmin = async (userId: string): Promise<boolean> => {
  try {
    const { data, error } = await supabase
      .from('admin_roles')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null)
      .single()

    return !error && !!data
  } catch (error) {
    console.error('Error checking admin status:', error)
    return false
  }
}

/**
 * Helper function to get admin role (without middleware)
 */
export const getAdminRole = async (
  userId: string
): Promise<'super_admin' | 'moderator' | 'support' | null> => {
  try {
    const { data, error } = await supabase
      .from('admin_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null)
      .single()

    if (error || !data) {
      return null
    }

    return data.role
  } catch (error) {
    console.error('Error getting admin role:', error)
    return null
  }
}

/**
 * Helper function to grant admin role
 * Should only be called by super admins
 */
export const grantAdminRole = async (
  userId: string,
  role: 'super_admin' | 'moderator' | 'support',
  grantedBy: string
): Promise<{ success: boolean; error?: string }> => {
  try {
    // Check if granter is a super admin
    const granterRole = await getAdminRole(grantedBy)
    if (granterRole !== 'super_admin') {
      return {
        success: false,
        error: 'Only super admins can grant admin roles'
      }
    }

    // Check if user already has an admin role
    const existingRole = await getAdminRole(userId)
    if (existingRole) {
      return {
        success: false,
        error: 'User already has an admin role'
      }
    }

    // Grant the role
    const { error } = await supabase
      .from('admin_roles')
      .insert({
        user_id: userId,
        role,
        granted_by: grantedBy
      })

    if (error) {
      console.error('Error granting admin role:', error)
      return {
        success: false,
        error: 'Failed to grant admin role'
      }
    }

    // Log the action
    await logAdminAction(grantedBy, 'grant_admin_role', 'user', userId, {
      role,
      grantedTo: userId
    })

    return { success: true }
  } catch (error) {
    console.error('Error in grantAdminRole:', error)
    return {
      success: false,
      error: 'Internal server error'
    }
  }
}

/**
 * Helper function to revoke admin role
 * Should only be called by super admins
 */
export const revokeAdminRole = async (
  userId: string,
  revokedBy: string
): Promise<{ success: boolean; error?: string }> => {
  try {
    // Check if revoker is a super admin
    const revokerRole = await getAdminRole(revokedBy)
    if (revokerRole !== 'super_admin') {
      return {
        success: false,
        error: 'Only super admins can revoke admin roles'
      }
    }

    // Prevent self-revocation
    if (userId === revokedBy) {
      return {
        success: false,
        error: 'Cannot revoke your own admin role'
      }
    }

    // Revoke the role
    const { error } = await supabase
      .from('admin_roles')
      .update({
        is_active: false,
        revoked_at: new Date().toISOString()
      })
      .eq('user_id', userId)

    if (error) {
      console.error('Error revoking admin role:', error)
      return {
        success: false,
        error: 'Failed to revoke admin role'
      }
    }

    // Log the action
    await logAdminAction(revokedBy, 'revoke_admin_role', 'user', userId, {
      revokedFrom: userId
    })

    return { success: true }
  } catch (error) {
    console.error('Error in revokeAdminRole:', error)
    return {
      success: false,
      error: 'Internal server error'
    }
  }
}
