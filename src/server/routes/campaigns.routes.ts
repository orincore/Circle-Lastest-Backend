import { Router } from 'express'
import { AuthRequest, requireAuth, requireAdmin } from '../middleware/auth.js'
import { and, count, desc, eq, gte, ilike, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { campaignAnalytics, marketingCampaigns, profiles, pushTokens, userCampaignInteractions } from '../db/schema.js'
import emailService from '../../services/emailService.js'

const router = Router()

function toCampaignJson(row: typeof marketingCampaigns.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    subject: row.subject,
    content: row.content,
    template_id: row.templateId,
    segment_criteria: row.segmentCriteria,
    scheduled_at: row.scheduledAt,
    sent_at: row.sentAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    push_title: row.pushTitle,
    push_body: row.pushBody,
  }
}

function toCampaignAnalyticsJson(row: typeof campaignAnalytics.$inferSelect) {
  return {
    id: row.id,
    campaign_id: row.campaignId,
    total_sent: row.totalSent,
    delivered: row.delivered,
    opened: row.opened,
    clicked: row.clicked,
    converted: row.converted,
    unsubscribed: row.unsubscribed,
    bounced: row.bounced,
    failed: row.failed,
    updated_at: row.updatedAt,
  }
}

// Get all campaigns with filters
router.get('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const {
      status,
      type,
      page = '1',
      limit = '20',
      search
    } = req.query

    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum

    const conditions = []
    if (status && status !== 'all') {
      conditions.push(eq(marketingCampaigns.status, status as string))
    }
    if (type && type !== 'all') {
      conditions.push(eq(marketingCampaigns.type, type as string))
    }
    if (search) {
      conditions.push(ilike(marketingCampaigns.name, `%${search}%`))
    }
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined

    const [{ count: total }] = await db.select({ count: count() }).from(marketingCampaigns).where(whereCondition)

    const rows = await db.select()
      .from(marketingCampaigns)
      .where(whereCondition)
      .orderBy(desc(marketingCampaigns.createdAt))
      .limit(limitNum)
      .offset(offset)

    // Attach campaign_analytics (one-to-one) like the original nested select did
    const campaignIds = rows.map(r => r.id)
    const analyticsRows = campaignIds.length > 0
      ? await db.select().from(campaignAnalytics).where(inArray(campaignAnalytics.campaignId, campaignIds))
      : []
    const analyticsByCampaign = new Map(analyticsRows.map(a => [a.campaignId, a]))

    const campaigns = rows.map(row => ({
      ...toCampaignJson(row),
      campaign_analytics: analyticsByCampaign.has(row.id) ? [toCampaignAnalyticsJson(analyticsByCampaign.get(row.id)!)] : [],
    }))

    res.json({
      campaigns,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: total || 0,
        totalPages: Math.ceil((total || 0) / limitNum)
      }
    })
  } catch (error) {
    console.error('Error fetching campaigns:', error)
    res.status(500).json({ error: 'Failed to fetch campaigns' })
  }
})

// Get campaign by ID
router.get('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const [row] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1)

    if (!row) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    const [analyticsRow] = await db.select().from(campaignAnalytics).where(eq(campaignAnalytics.campaignId, id)).limit(1)

    res.json({
      ...toCampaignJson(row),
      campaign_analytics: analyticsRow ? [toCampaignAnalyticsJson(analyticsRow)] : [],
    })
  } catch (error) {
    console.error('Error fetching campaign:', error)
    res.status(500).json({ error: 'Failed to fetch campaign' })
  }
})

// Create new campaign
router.post('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const {
      name,
      type,
      subject,
      content,
      template_id,
      segment_criteria,
      scheduled_at,
      push_title,
      push_body,
    } = req.body

    const userId = req.user!.id

    // Validate required fields
    if (!name || !type || !content) {
      return res.status(400).json({ error: 'Name, type, and content are required' })
    }

    // Create campaign
    const [campaign] = await db.insert(marketingCampaigns).values({
      name,
      type,
      subject,
      content,
      templateId: template_id,
      segmentCriteria: segment_criteria,
      scheduledAt: scheduled_at,
      pushTitle: push_title,
      pushBody: push_body,
      status: scheduled_at ? 'scheduled' : 'draft',
      createdBy: userId,
    }).returning()

    // Create analytics record
    await db.insert(campaignAnalytics).values({ campaignId: campaign.id })

    res.status(201).json(toCampaignJson(campaign))
  } catch (error) {
    console.error('Error creating campaign:', error)
    res.status(500).json({ error: 'Failed to create campaign' })
  }
})

// Update campaign
router.put('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const updates = req.body

    // Don't allow updating sent campaigns
    const [existing] = await db.select({ status: marketingCampaigns.status }).from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1)

    if (existing?.status === 'sent') {
      return res.status(400).json({ error: 'Cannot update sent campaigns' })
    }

    // Map snake_case update fields (from admin panel) to camelCase Drizzle columns
    const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (updates.name !== undefined) updateData.name = updates.name
    if (updates.type !== undefined) updateData.type = updates.type
    if (updates.status !== undefined) updateData.status = updates.status
    if (updates.subject !== undefined) updateData.subject = updates.subject
    if (updates.content !== undefined) updateData.content = updates.content
    if (updates.template_id !== undefined) updateData.templateId = updates.template_id
    if (updates.segment_criteria !== undefined) updateData.segmentCriteria = updates.segment_criteria
    if (updates.scheduled_at !== undefined) updateData.scheduledAt = updates.scheduled_at
    if (updates.sent_at !== undefined) updateData.sentAt = updates.sent_at
    if (updates.push_title !== undefined) updateData.pushTitle = updates.push_title
    if (updates.push_body !== undefined) updateData.pushBody = updates.push_body

    const [row] = await db.update(marketingCampaigns).set(updateData).where(eq(marketingCampaigns.id, id)).returning()

    res.json(toCampaignJson(row))
  } catch (error) {
    console.error('Error updating campaign:', error)
    res.status(500).json({ error: 'Failed to update campaign' })
  }
})

// Delete campaign
router.delete('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    // Don't allow deleting sent campaigns
    const [existing] = await db.select({ status: marketingCampaigns.status }).from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1)

    if (existing?.status === 'sent' || existing?.status === 'sending') {
      return res.status(400).json({ error: 'Cannot delete sent or sending campaigns' })
    }

    await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, id))

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting campaign:', error)
    res.status(500).json({ error: 'Failed to delete campaign' })
  }
})

// Send campaign
router.post('/:id/send', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    // Get campaign
    const [campaignRow] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1)

    if (!campaignRow) {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    const campaign = toCampaignJson(campaignRow)

    if (campaign.status === 'sent') {
      return res.status(400).json({ error: 'Campaign already sent' })
    }

    // Get target users based on segment criteria
    const users = await getSegmentedUsers(campaign.segment_criteria)

    // Update campaign status
    await db.update(marketingCampaigns).set({
      status: 'sending',
      sentAt: new Date().toISOString(),
    }).where(eq(marketingCampaigns.id, id))

    // Send campaign based on type
    const interactions: { campaign_id: string; user_id: string; action: string; created_at: string }[] = []
    let sentCount = 0

    if (campaign.type === 'email') {
      // Send email campaigns
      //console.log(`📧 Sending email campaign to ${users.length} users`)

      for (const user of users) {
        try {
          if (user.email) {
            // Create email with tracking
            const html = emailService.createEmailTemplate({
              title: campaign.subject || campaign.name,
              content: campaign.content,
              campaignId: id,
              userId: user.id,
            })

            await emailService.sendEmail({
              to: user.email,
              subject: campaign.subject || campaign.name,
              html,
            })

            sentCount++
            interactions.push({
              campaign_id: id,
              user_id: user.id,
              action: 'sent',
              created_at: new Date().toISOString()
            })
          }
        } catch (error) {
          console.error(`Failed to send email to user ${user.id}:`, error)
        }
      }
    } else if (campaign.type === 'push_notification') {
      // Send push notification campaigns
      // Allow explicit push title/body fields from admin panel, with safe fallbacks
      const pushTitle = campaign.push_title || campaign.subject || campaign.name;
      const pushBody = campaign.push_body || campaign.content;

      //console.log(`📱 Sending push notification campaign to ${users.length} users`)

      for (const user of users) {
        try {
          // Get user's push token
          const [pushToken] = await db.select({ token: pushTokens.token })
            .from(pushTokens)
            .where(and(eq(pushTokens.userId, user.id), eq(pushTokens.enabled, true)))
            .orderBy(desc(pushTokens.createdAt))
            .limit(1)

          if (pushToken?.token) {
            // Send push notification using Expo
            const message = {
              to: pushToken.token,
              sound: 'default',
              title: pushTitle,
              body: pushBody,
              data: {
                campaignId: id,
                type: 'marketing_campaign',
                title: pushTitle,
                body: pushBody,
              },
            }

            const response = await fetch('https://exp.host/--/api/v2/push/send', {
              method: 'POST',
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(message),
            })

            if (response.ok) {
              sentCount++
              interactions.push({
                campaign_id: id,
                user_id: user.id,
                action: 'sent',
                created_at: new Date().toISOString()
              })
            }
          }
        } catch (error) {
          console.error(`Failed to send push notification to user ${user.id}:`, error)
        }
      }
    } else if (campaign.type === 'in_app') {
      // In-app notifications (future implementation)
      //console.log(`📲 In-app notifications not yet implemented`)
    }

    // Save interaction records
    if (interactions.length > 0) {
      await db.insert(userCampaignInteractions).values(interactions.map(i => ({
        campaignId: i.campaign_id,
        userId: i.user_id,
        action: i.action,
        createdAt: i.created_at,
      })))
    }

    // Update analytics
    await db.update(campaignAnalytics).set({
      totalSent: sentCount,
      delivered: sentCount,
      updatedAt: new Date().toISOString(),
    }).where(eq(campaignAnalytics.campaignId, id))

    // Mark as sent
    await db.update(marketingCampaigns).set({ status: 'sent' }).where(eq(marketingCampaigns.id, id))

    //console.log(`✅ Campaign ${id} sent to ${sentCount}/${users.length} users`)

    res.json({
      success: true,
      sent_to: sentCount,
      total_users: users.length,
      message: `Campaign sent to ${sentCount} users (${users.length - sentCount} users don't have push tokens)`
    })
  } catch (error) {
    console.error('Error sending campaign:', error)
    res.status(500).json({ error: 'Failed to send campaign' })
  }
})

// Get campaign analytics
router.get('/:id/analytics', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const [analyticsRow] = await db.select().from(campaignAnalytics).where(eq(campaignAnalytics.campaignId, id)).limit(1)

    if (!analyticsRow) {
      throw new Error('Campaign analytics not found')
    }

    // Get detailed interactions
    const interactionRows = await db.select({
      action: userCampaignInteractions.action,
      created_at: userCampaignInteractions.createdAt,
    }).from(userCampaignInteractions).where(eq(userCampaignInteractions.campaignId, id))

    res.json({
      ...toCampaignAnalyticsJson(analyticsRow),
      interactions: interactionRows || []
    })
  } catch (error) {
    console.error('Error fetching analytics:', error)
    res.status(500).json({ error: 'Failed to fetch analytics' })
  }
})

// Track email opens
router.get('/:id/track/open', async (req, res) => {
  try {
    const { id } = req.params
    const { userId } = req.query

    if (!userId) {
      // Return 1x1 transparent pixel even if no userId
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': pixel.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate, private'
      })
      return res.end(pixel)
    }

    // Record the open
    await db.insert(userCampaignInteractions).values({
      campaignId: id,
      userId: userId as string,
      action: 'opened',
      createdAt: new Date().toISOString(),
    })

    // Update analytics
    const [analytics] = await db.select({ opened: campaignAnalytics.opened }).from(campaignAnalytics).where(eq(campaignAnalytics.campaignId, id)).limit(1)

    if (analytics) {
      await db.update(campaignAnalytics).set({
        opened: (analytics.opened || 0) + 1,
        updatedAt: new Date().toISOString(),
      }).where(eq(campaignAnalytics.campaignId, id))
    }

    // Return 1x1 transparent pixel
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': pixel.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    })
    res.end(pixel)
  } catch (error) {
    console.error('Error tracking open:', error)
    // Still return pixel even on error
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': pixel.length
    })
    res.end(pixel)
  }
})

// Track email clicks
router.get('/:id/track/click', async (req, res) => {
  try {
    const { id } = req.params
    const { userId, url } = req.query

    if (userId) {
      // Record the click
      await db.insert(userCampaignInteractions).values({
        campaignId: id,
        userId: userId as string,
        action: 'clicked',
        createdAt: new Date().toISOString(),
      })

      // Update analytics
      const [analytics] = await db.select({ clicked: campaignAnalytics.clicked }).from(campaignAnalytics).where(eq(campaignAnalytics.campaignId, id)).limit(1)

      if (analytics) {
        await db.update(campaignAnalytics).set({
          clicked: (analytics.clicked || 0) + 1,
          updatedAt: new Date().toISOString(),
        }).where(eq(campaignAnalytics.campaignId, id))
      }
    }

    // Redirect to the actual URL
    if (url) {
      res.redirect(decodeURIComponent(url as string))
    } else {
      res.redirect('https://circle.orincore.com')
    }
  } catch (error) {
    console.error('Error tracking click:', error)
    // Redirect anyway
    if (req.query.url) {
      res.redirect(decodeURIComponent(req.query.url as string))
    } else {
      res.redirect('https://circle.orincore.com')
    }
  }
})

// Helper function to get segmented users
async function getSegmentedUsers(criteria: any) {
  const conditions = [isNull(profiles.deletedAt), eq(profiles.isSuspended, false)]

  if (criteria) {
    if (criteria.gender) {
      conditions.push(eq(profiles.gender, criteria.gender))
    }
    if (criteria.age_min) {
      conditions.push(gte(profiles.age, criteria.age_min))
    }
    if (criteria.age_max) {
      conditions.push(lte(profiles.age, criteria.age_max))
    }
    if (criteria.location_city) {
      conditions.push(eq(profiles.locationCity, criteria.location_city))
    }
    if (criteria.location_country) {
      conditions.push(eq(profiles.locationCountry, criteria.location_country))
    }
    if (criteria.interests && criteria.interests.length > 0) {
      // Interpolating a JS array directly into a sql`` template expands it into a
      // comma-separated parameter list, not a Postgres array literal — build a
      // real ARRAY[...]::text[] literal instead (same fix as prompt-matching.service.ts).
      const interestsArray = sql`ARRAY[${sql.join(criteria.interests.map((v: string) => sql`${v}`), sql`, `)}]::text[]`
      conditions.push(sql`${profiles.interests} @> ${interestsArray}`)
    }
  }

  const rows = await db.select({ id: profiles.id, email: profiles.email, first_name: profiles.firstName })
    .from(profiles)
    .where(and(...conditions))

  return rows || []
}

export default router
