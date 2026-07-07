/**
 * Admin User Management Routes
 * Handles user listing, search, filtering, and user actions
 */

import express from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import {
  requireAdmin,
  requireModerator,
  AdminRequest,
  logAdminAction
} from '../middleware/adminAuth.js'
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../config/db.js'
import {
  profiles,
  friendships,
  messages,
  userReports,
  userSubscriptions,
  refunds,
  faceVerifications,
  verificationAttempts,
} from '../db/schema.js'

const router = express.Router()

// ============================================
// Row -> snake_case response mappers
// ============================================

function mapProfileRow(row: typeof profiles.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    first_name: row.firstName,
    last_name: row.lastName,
    age: row.age,
    gender: row.gender,
    phone_number: row.phoneNumber,
    profile_photo_url: row.profilePhotoUrl,
    password_hash: row.passwordHash,
    created_at: row.createdAt,
    interests: row.interests,
    needs: row.needs,
    latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
    longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
    location_address: row.locationAddress,
    location_city: row.locationCity,
    location_country: row.locationCountry,
    location_updated_at: row.locationUpdatedAt,
    location_preference: row.locationPreference,
    age_preference: row.agePreference,
    friendship_location_priority: row.friendshipLocationPriority,
    relationship_distance_flexible: row.relationshipDistanceFlexible,
    preferences_updated_at: row.preferencesUpdatedAt,
    updated_at: row.updatedAt,
    about: row.about,
    circle_points: row.circlePoints,
    total_matches: row.totalMatches,
    messages_sent: row.messagesSent,
    messages_received: row.messagesReceived,
    profile_visits_received: row.profileVisitsReceived,
    total_friends: row.totalFriends,
    last_active: row.lastActive,
    stats_updated_at: row.statsUpdatedAt,
    total_calls_made: row.totalCallsMade,
    total_calls_received: row.totalCallsReceived,
    total_call_duration_seconds: row.totalCallDurationSeconds,
    instagram_username: row.instagramUsername,
    invisible_mode: row.invisibleMode,
    last_seen: row.lastSeen,
    is_suspended: row.isSuspended,
    suspension_reason: row.suspensionReason,
    suspension_ends_at: row.suspensionEndsAt,
    suspended_at: row.suspendedAt,
    suspended_by: row.suspendedBy,
    deleted_at: row.deletedAt,
    deleted_by: row.deletedBy,
    deletion_reason: row.deletionReason,
    deletion_feedback: row.deletionFeedback,
    email_verified: row.emailVerified,
    email_verified_at: row.emailVerifiedAt,
    subscription_plan: row.subscriptionPlan,
    premium_expires_at: row.premiumExpiresAt,
    is_deleted: row.isDeleted,
    verification_status: row.verificationStatus,
    verified_at: row.verifiedAt,
    verification_required: row.verificationRequired,
    is_premium: row.isPremium,
    subscription_expires_at: row.subscriptionExpiresAt,
    role: row.role,
    is_admin: row.isAdmin,
  }
}

function mapReportRow(row: typeof userReports.$inferSelect) {
  return {
    id: row.id,
    reporter_id: row.reporterId,
    reported_user_id: row.reportedUserId,
    report_type: row.reportType,
    reason: row.reason,
    evidence: row.evidence,
    status: row.status,
    moderator_id: row.moderatorId,
    moderator_notes: row.moderatorNotes,
    action_taken: row.actionTaken,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    resolved_at: row.resolvedAt,
    message_id: row.messageId,
    chat_id: row.chatId,
    additional_details: row.additionalDetails,
  }
}

function mapUserSubscriptionRow(row: typeof userSubscriptions.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    plan_type: row.planId,
    status: row.status,
    source: row.source,
    started_at: row.startedAt,
    expires_at: row.expiresAt,
    cancelled_at: row.cancelledAt,
    auto_renew: row.autoRenew,
    amount: row.amount !== null && row.amount !== undefined ? Number(row.amount) : null,
    currency: row.currency,
    apple_original_transaction_id: row.appleOriginalTransactionId,
    google_purchase_token: row.googlePurchaseToken,
    razorpay_subscription_id: row.razorpaySubscriptionId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function mapFaceVerificationRow(row: typeof faceVerifications.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    status: row.status,
    video_s3_key: row.videoS3Key,
    verification_data: row.verificationData,
    confidence: row.confidence !== null && row.confidence !== undefined ? Number(row.confidence) : null,
    movements_detected: row.movementsDetected,
    submitted_at: row.submittedAt,
    verified_at: row.verifiedAt,
    expires_at: row.expiresAt,
    reviewed_by: row.reviewedBy,
    review_notes: row.reviewNotes,
    reviewed_at: row.reviewedAt,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    device_info: row.deviceInfo,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function mapVerificationAttemptRow(row: typeof verificationAttempts.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    verification_id: row.verificationId,
    success: row.success,
    failure_reason: row.failureReason,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    device_info: row.deviceInfo,
    created_at: row.createdAt,
  }
}

const USER_SORTABLE_COLUMNS: Record<string, any> = {
  created_at: profiles.createdAt,
  email: profiles.email,
  username: profiles.username,
  first_name: profiles.firstName,
  last_name: profiles.lastName,
  age: profiles.age,
  last_seen: profiles.lastSeen,
  verified_at: profiles.verifiedAt,
  deleted_at: profiles.deletedAt,
  is_suspended: profiles.isSuspended,
}

// ============================================
// User Listing & Search
// ============================================

/**
 * Get users list with pagination, search, and filters
 * GET /api/admin/users
 */
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      page = '1',
      limit = '50',
      search = '',
      status = 'all',
      sortBy = 'created_at',
      sortOrder = 'desc',
      gender,
      minAge,
      maxAge,
      startDate,
      endDate
    } = req.query

    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum

    // Build filters
    const conditions = []

    // Search filter
    if (search) {
      const searchTerm = `%${search}%`
      conditions.push(or(
        ilike(profiles.email, searchTerm),
        ilike(profiles.username, searchTerm),
        ilike(profiles.firstName, searchTerm),
        ilike(profiles.lastName, searchTerm),
        ilike(profiles.phoneNumber, searchTerm),
      ))
    }

    // Status filter
    if (status === 'active') {
      conditions.push(sql`${profiles.deletedAt} is null`)
      conditions.push(eq(profiles.isSuspended, false))
    } else if (status === 'suspended') {
      conditions.push(eq(profiles.isSuspended, true))
    } else if (status === 'deleted') {
      conditions.push(sql`${profiles.deletedAt} is not null`)
    }

    // Gender filter
    if (gender) {
      conditions.push(eq(profiles.gender, gender as string))
    }

    // Age filter
    if (minAge) {
      conditions.push(gte(profiles.age, parseInt(minAge as string)))
    }
    if (maxAge) {
      conditions.push(lte(profiles.age, parseInt(maxAge as string)))
    }

    // Date range filter
    if (startDate) {
      conditions.push(gte(profiles.createdAt, startDate as string))
    }
    if (endDate) {
      conditions.push(lte(profiles.createdAt, endDate as string))
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(profiles).where(whereClause)

    // Sorting
    const ascending = sortOrder === 'asc'
    const sortColumn = USER_SORTABLE_COLUMNS[sortBy as string] || profiles.createdAt
    const orderFn = ascending ? asc : desc

    const rows = await db.select({
      id: profiles.id,
      email: profiles.email,
      email_verified: profiles.emailVerified,
      username: profiles.username,
      first_name: profiles.firstName,
      last_name: profiles.lastName,
      age: profiles.age,
      gender: profiles.gender,
      phone_number: profiles.phoneNumber,
      profile_photo_url: profiles.profilePhotoUrl,
      verification_status: profiles.verificationStatus,
      verified_at: profiles.verifiedAt,
      created_at: profiles.createdAt,
      last_seen: profiles.lastSeen,
      is_suspended: profiles.isSuspended,
      suspension_reason: profiles.suspensionReason,
      deleted_at: profiles.deletedAt,
    })
      .from(profiles)
      .where(whereClause)
      .orderBy(orderFn(sortColumn))
      .limit(limitNum)
      .offset(offset)

    // Log the action
    await logAdminAction(req.user!.id, 'view_users', 'users', null, {
      filters: { search, status, gender, minAge, maxAge },
      page: pageNum,
      limit: limitNum
    })

    return res.json({
      users: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    })
  } catch (error) {
    console.error('User list error:', error)
    return res.status(500).json({ error: 'Failed to fetch users' })
  }
})

/**
 * Quick search for users (for modals/autocomplete)
 * GET /api/admin/users/search
 */
router.get('/search', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { q = '', limit = '10' } = req.query
    const searchTerm = (q as string).trim()
    const limitNum = Math.min(parseInt(limit as string) || 10, 50)

    if (searchTerm.length < 2) {
      return res.json({ users: [] })
    }

    const searchPattern = `%${searchTerm}%`

    const rows = await db.select({
      id: profiles.id,
      email: profiles.email,
      username: profiles.username,
      first_name: profiles.firstName,
      last_name: profiles.lastName,
      age: profiles.age,
      gender: profiles.gender,
      profile_photo_url: profiles.profilePhotoUrl,
    })
      .from(profiles)
      .where(and(
        sql`${profiles.deletedAt} is null`,
        or(
          ilike(profiles.email, searchPattern),
          ilike(profiles.username, searchPattern),
          ilike(profiles.firstName, searchPattern),
          ilike(profiles.lastName, searchPattern),
        )
      ))
      .limit(limitNum)

    return res.json({ users: rows || [] })
  } catch (error) {
    console.error('User search error:', error)
    return res.status(500).json({ error: 'Failed to search users' })
  }
})

/**
 * Get user details by ID
 * GET /api/admin/users/:userId
 */
router.get('/:userId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    const {
      activityLimit = '50',
      subscriptionsLimit = '50',
      refundsLimit = '50',
      verificationLimit = '10'
    } = req.query

    // Get user profile
    const [userRow] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1)

    if (!userRow) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = mapProfileRow(userRow)

    // Get user statistics
    const [{ count: friendsCount }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(friendships)
      .where(and(
        or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
        eq(friendships.status, 'active'),
      ))

    const [{ count: messagesCount }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(messages).where(eq(messages.senderId, userId))

    const [{ count: reportsReceived }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(eq(userReports.reportedUserId, userId))

    const [{ count: reportsSent }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(eq(userReports.reporterId, userId))

    const activityLimitNum = Math.min(parseInt(activityLimit as string) || 50, 200)
    const subscriptionsLimitNum = Math.min(parseInt(subscriptionsLimit as string) || 50, 200)
    const refundsLimitNum = Math.min(parseInt(refundsLimit as string) || 50, 200)
    const verificationLimitNum = Math.min(parseInt(verificationLimit as string) || 10, 50)

    const recentMessages = await db.select({
      id: messages.id,
      content: messages.text,
      created_at: messages.createdAt,
      chat_id: messages.chatId,
    })
      .from(messages)
      .where(eq(messages.senderId, userId))
      .orderBy(desc(messages.createdAt))
      .limit(activityLimitNum)

    const recentFriendships = await db.select({
      id: friendships.id,
      created_at: friendships.createdAt,
      status: friendships.status,
      user1_id: friendships.user1Id,
      user2_id: friendships.user2Id,
    })
      .from(friendships)
      .where(or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)))
      .orderBy(desc(friendships.createdAt))
      .limit(50)

    const recentReportRows = await db.select().from(userReports)
      .where(or(eq(userReports.reporterId, userId), eq(userReports.reportedUserId, userId)))
      .orderBy(desc(userReports.createdAt))
      .limit(50)
    const recentReports = recentReportRows.map(mapReportRow)

    const subscriptionRows = await db.select().from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .orderBy(desc(userSubscriptions.createdAt))
      .limit(subscriptionsLimitNum)
    const userSubscriptionsOut = subscriptionRows.map(mapUserSubscriptionRow)

    const processedByProfiles = alias(profiles, 'refund_processed_by_profiles')
    const refundRows = await db.select({
      id: refunds.id,
      subscription_id: refunds.subscriptionId,
      user_id: refunds.userId,
      amount: refunds.amount,
      currency: refunds.currency,
      reason: refunds.reason,
      status: refunds.status,
      requested_at: refunds.requestedAt,
      processed_at: refunds.processedAt,
      processed_by: refunds.processedBy,
      payment_provider: refunds.paymentProvider,
      external_refund_id: refunds.externalRefundId,
      refund_method: refunds.refundMethod,
      admin_notes: refunds.adminNotes,
      created_at: refunds.createdAt,
      updated_at: refunds.updatedAt,
      subscription_plan_type: userSubscriptions.planId,
      subscription_started_at: userSubscriptions.startedAt,
      processed_by_username: processedByProfiles.username,
    })
      .from(refunds)
      .leftJoin(userSubscriptions, eq(userSubscriptions.id, refunds.subscriptionId))
      .leftJoin(processedByProfiles, eq(processedByProfiles.id, refunds.processedBy))
      .where(eq(refunds.userId, userId))
      .orderBy(desc(refunds.requestedAt))
      .limit(refundsLimitNum)

    const refundsOut = refundRows.map(r => ({
      id: r.id,
      subscription_id: r.subscription_id,
      user_id: r.user_id,
      amount: r.amount !== null ? Number(r.amount) : null,
      currency: r.currency,
      reason: r.reason,
      status: r.status,
      requested_at: r.requested_at,
      processed_at: r.processed_at,
      processed_by: r.processed_by,
      payment_provider: r.payment_provider,
      external_refund_id: r.external_refund_id,
      refund_method: r.refund_method,
      admin_notes: r.admin_notes,
      created_at: r.created_at,
      updated_at: r.updated_at,
      subscription: r.subscription_plan_type !== null ? {
        plan_type: r.subscription_plan_type,
        started_at: r.subscription_started_at,
      } : null,
      processed_by_profile: r.processed_by_username !== null ? {
        username: r.processed_by_username,
      } : null,
    }))

    const faceVerificationRows = await db.select().from(faceVerifications)
      .where(eq(faceVerifications.userId, userId))
      .orderBy(desc(faceVerifications.createdAt))
      .limit(verificationLimitNum)
    const faceVerificationsOut = faceVerificationRows.map(mapFaceVerificationRow)

    const verificationAttemptRows = await db.select().from(verificationAttempts)
      .where(eq(verificationAttempts.userId, userId))
      .orderBy(desc(verificationAttempts.createdAt))
      .limit(verificationLimitNum)
    const verificationAttemptsOut = verificationAttemptRows.map(mapVerificationAttemptRow)

    // Log the action
    await logAdminAction(req.user!.id, 'view_user_details', 'user', userId, {
      userEmail: user.email
    })

    return res.json({
      user,
      stats: {
        friendsCount: friendsCount || 0,
        messagesCount: messagesCount || 0,
        reportsReceived: reportsReceived || 0,
        reportsSent: reportsSent || 0
      },
      activity: {
        messages: recentMessages || [],
        friendships: recentFriendships || [],
        reports: recentReports || []
      },
      subscriptions: {
        subscriptions: userSubscriptionsOut || []
      },
      refunds: refundsOut || [],
      verification: {
        faceVerifications: faceVerificationsOut || [],
        attempts: verificationAttemptsOut || []
      }
    })
  } catch (error) {
    console.error('User details error:', error)
    return res.status(500).json({ error: 'Failed to fetch user details' })
  }
})

// ============================================
// User Actions
// ============================================

router.post('/:userId/verify', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    const [existingUser] = await db.select({
      id: profiles.id,
      email: profiles.email,
      verification_status: profiles.verificationStatus,
    }).from(profiles).where(eq(profiles.id, userId)).limit(1)

    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (existingUser.verification_status === 'verified') {
      return res.json({
        success: true,
        message: 'User already verified'
      })
    }

    const [updatedRow] = await db.update(profiles).set({
      verificationStatus: 'verified',
      verifiedAt: new Date().toISOString(),
      verificationRequired: false
    }).where(eq(profiles.id, userId)).returning()

    if (!updatedRow) {
      console.error('Error verifying user: no row returned')
      return res.status(500).json({ error: 'Failed to verify user' })
    }

    await logAdminAction(req.user!.id, 'verify_user', 'user', userId, {
      userEmail: existingUser.email
    })

    return res.json({
      success: true,
      user: mapProfileRow(updatedRow)
    })
  } catch (error) {
    console.error('Verify user error:', error)
    return res.status(500).json({ error: 'Failed to verify user' })
  }
})

router.post('/:userId/unverify', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    const [existingUser] = await db.select({
      id: profiles.id,
      email: profiles.email,
      verification_status: profiles.verificationStatus,
    }).from(profiles).where(eq(profiles.id, userId)).limit(1)

    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (existingUser.verification_status === 'pending') {
      return res.json({
        success: true,
        message: 'User already pending'
      })
    }

    const [updatedRow] = await db.update(profiles).set({
      verificationStatus: 'pending',
      verifiedAt: null,
      verificationRequired: true
    }).where(eq(profiles.id, userId)).returning()

    if (!updatedRow) {
      console.error('Error unverifying user: no row returned')
      return res.status(500).json({ error: 'Failed to unverify user' })
    }

    await logAdminAction(req.user!.id, 'unverify_user', 'user', userId, {
      userEmail: existingUser.email
    })

    return res.json({
      success: true,
      user: mapProfileRow(updatedRow)
    })
  } catch (error) {
    console.error('Unverify user error:', error)
    return res.status(500).json({ error: 'Failed to unverify user' })
  }
})

/**
 * Suspend user
 * POST /api/admin/users/:userId/suspend
 */
router.post('/:userId/suspend', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params
    const { reason, duration } = req.body

    if (!reason) {
      return res.status(400).json({ error: 'Suspension reason is required' })
    }

    // Calculate suspension end date if duration provided (in days)
    let suspensionEndsAt: string | null = null
    if (duration && duration > 0) {
      const endDate = new Date()
      endDate.setDate(endDate.getDate() + duration)
      suspensionEndsAt = endDate.toISOString()
    }

    // Update user
    await db.update(profiles).set({
      isSuspended: true,
      suspensionReason: reason,
      suspensionEndsAt,
      suspendedAt: new Date().toISOString(),
      suspendedBy: req.user!.id
    }).where(eq(profiles.id, userId))

    // Log the action
    await logAdminAction(req.user!.id, 'suspend_user', 'user', userId, {
      reason,
      duration,
      suspensionEndsAt
    })

    return res.json({
      success: true,
      message: 'User suspended successfully'
    })
  } catch (error) {
    console.error('Suspend user error:', error)
    return res.status(500).json({ error: 'Failed to suspend user' })
  }
})

/**
 * Unsuspend user
 * POST /api/admin/users/:userId/unsuspend
 */
router.post('/:userId/unsuspend', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    // Update user
    await db.update(profiles).set({
      isSuspended: false,
      suspensionReason: null,
      suspensionEndsAt: null,
      suspendedAt: null,
      suspendedBy: null
    }).where(eq(profiles.id, userId))

    // Log the action
    await logAdminAction(req.user!.id, 'unsuspend_user', 'user', userId, {})

    return res.json({
      success: true,
      message: 'User unsuspended successfully'
    })
  } catch (error) {
    console.error('Unsuspend user error:', error)
    return res.status(500).json({ error: 'Failed to unsuspend user' })
  }
})

/**
 * Delete user (soft delete)
 * DELETE /api/admin/users/:userId
 */
router.delete('/:userId', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params
    const { reason } = req.body

    // Soft delete user
    await db.update(profiles).set({
      deletedAt: new Date().toISOString(),
      deletedBy: req.user!.id,
      deletionReason: reason || 'Admin deletion'
    }).where(eq(profiles.id, userId))

    // Log the action
    await logAdminAction(req.user!.id, 'delete_user', 'user', userId, {
      reason: reason || 'Admin deletion'
    })

    return res.json({
      success: true,
      message: 'User deleted successfully'
    })
  } catch (error) {
    console.error('Delete user error:', error)
    return res.status(500).json({ error: 'Failed to delete user' })
  }
})

/**
 * Restore deleted user
 * POST /api/admin/users/:userId/restore
 */
router.post('/:userId/restore', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    // Restore user
    await db.update(profiles).set({
      deletedAt: null,
      deletedBy: null,
      deletionReason: null
    }).where(eq(profiles.id, userId))

    // Log the action
    await logAdminAction(req.user!.id, 'restore_user', 'user', userId, {})

    return res.json({
      success: true,
      message: 'User restored successfully'
    })
  } catch (error) {
    console.error('Restore user error:', error)
    return res.status(500).json({ error: 'Failed to restore user' })
  }
})

/**
 * Get user activity history
 * GET /api/admin/users/:userId/activity
 */
router.get('/:userId/activity', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params
    const { limit = '50' } = req.query

    // Get recent messages
    const messagesOut = await db.select({
      id: messages.id,
      content: messages.text,
      created_at: messages.createdAt,
      chat_id: messages.chatId,
    })
      .from(messages)
      .where(eq(messages.senderId, userId))
      .orderBy(desc(messages.createdAt))
      .limit(parseInt(limit as string))

    // Get recent friend requests
    const friendRequests = await db.select({
      id: friendships.id,
      created_at: friendships.createdAt,
      status: friendships.status,
    })
      .from(friendships)
      .where(or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)))
      .orderBy(desc(friendships.createdAt))
      .limit(20)

    // Get reports involving user
    const reportRows = await db.select().from(userReports)
      .where(or(eq(userReports.reporterId, userId), eq(userReports.reportedUserId, userId)))
      .orderBy(desc(userReports.createdAt))
      .limit(20)
    const reports = reportRows.map(mapReportRow)

    return res.json({
      messages: messagesOut || [],
      friendRequests: friendRequests || [],
      reports: reports || []
    })
  } catch (error) {
    console.error('User activity error:', error)
    return res.status(500).json({ error: 'Failed to fetch user activity' })
  }
})

/**
 * Bulk user actions
 * POST /api/admin/users/bulk-action
 * NOTE: Bulk/mutate-all-users style endpoint — affects an arbitrary set of users at once.
 */
router.post('/bulk-action', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userIds, action, reason } = req.body

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'User IDs array is required' })
    }

    if (!action || !['suspend', 'unsuspend', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' })
    }

    let updateData: any = {}
    let actionName = ''

    switch (action) {
      case 'suspend':
        updateData = {
          isSuspended: true,
          suspensionReason: reason || 'Bulk suspension',
          suspendedAt: new Date().toISOString(),
          suspendedBy: req.user!.id
        }
        actionName = 'bulk_suspend_users'
        break
      case 'unsuspend':
        updateData = {
          isSuspended: false,
          suspensionReason: null,
          suspensionEndsAt: null,
          suspendedAt: null,
          suspendedBy: null
        }
        actionName = 'bulk_unsuspend_users'
        break
      case 'delete':
        updateData = {
          deletedAt: new Date().toISOString(),
          deletedBy: req.user!.id,
          deletionReason: reason || 'Bulk deletion'
        }
        actionName = 'bulk_delete_users'
        break
    }

    // Perform bulk update
    await db.update(profiles).set(updateData).where(inArray(profiles.id, userIds))

    // Log the action
    await logAdminAction(req.user!.id, actionName, 'users', null, {
      userIds,
      action,
      reason,
      count: userIds.length
    })

    return res.json({
      success: true,
      message: `Bulk ${action} completed successfully`,
      affectedUsers: userIds.length
    })
  } catch (error) {
    console.error('Bulk action error:', error)
    return res.status(500).json({ error: 'Failed to perform bulk action' })
  }
})

export default router
