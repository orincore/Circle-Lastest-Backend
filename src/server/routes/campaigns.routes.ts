import { Router } from 'express'
import { AuthRequest, requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import emailService from '../../services/emailService.js'

const router = Router()

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

    let query = supabase
      .from('marketing_campaigns')
      .select('*, campaign_analytics(*)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1)

    if (status && status !== 'all') {
      query = query.eq('status', status)
    }

    if (type && type !== 'all') {
      query = query.eq('type', type)
    }

    if (search) {
      query = query.ilike('name', `%${search}%`)
    }

    const { data, error, count } = await query

    if (error) throw error

    res.json({
      campaigns: data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
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

    const { data, error } = await supabase
      .from('marketing_campaigns')
      .select('*, campaign_analytics(*)')
      .eq('id', id)
      .single()

    if (error) throw error
    if (!data) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    res.json(data)
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
      scheduled_at 
    } = req.body

    const userId = req.user!.id

    // Validate required fields
    if (!name || !type || !content) {
      return res.status(400).json({ error: 'Name, type, and content are required' })
    }

    // Create campaign
    const { data: campaign, error: campaignError } = await supabase
      .from('marketing_campaigns')
      .insert({
        name,
        type,
        subject,
        content,
        template_id,
        segment_criteria,
        scheduled_at,
        status: scheduled_at ? 'scheduled' : 'draft',
        created_by: userId
      })
      .select()
      .single()

    if (campaignError) throw campaignError

    // Create analytics record
    await supabase
      .from('campaign_analytics')
      .insert({ campaign_id: campaign.id })

    res.status(201).json(campaign)
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
    const { data: existing } = await supabase
      .from('marketing_campaigns')
      .select('status')
      .eq('id', id)
      .single()

    if (existing?.status === 'sent') {
      return res.status(400).json({ error: 'Cannot update sent campaigns' })
    }

    const { data, error } = await supabase
      .from('marketing_campaigns')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json(data)
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
    const { data: existing } = await supabase
      .from('marketing_campaigns')
      .select('status')
      .eq('id', id)
      .single()

    if (existing?.status === 'sent' || existing?.status === 'sending') {
      return res.status(400).json({ error: 'Cannot delete sent or sending campaigns' })
    }

    const { error } = await supabase
      .from('marketing_campaigns')
      .delete()
      .eq('id', id)

    if (error) throw error

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
    const { data: campaign, error: campaignError } = await supabase
      .from('marketing_campaigns')
      .select('*')
      .eq('id', id)
      .single()

    if (campaignError) throw campaignError
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    if (campaign.status === 'sent') {
      return res.status(400).json({ error: 'Campaign already sent' })
    }

    // Get target users based on segment criteria
    const users = await getSegmentedUsers(campaign.segment_criteria)

    // Update campaign status
    await supabase
      .from('marketing_campaigns')
      .update({ 
        status: 'sending',
        sent_at: new Date().toISOString()
      })
      .eq('id', id)

    // Send campaign based on type
    const interactions = []
    let sentCount = 0
    
    if (campaign.type === 'email') {
      // Send email campaigns
      console.log(`📧 Sending email campaign to ${users.length} users`)
      
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
      console.log(`📱 Sending push notification campaign to ${users.length} users`)
      
      for (const user of users) {
        try {
          // Get user's push token
          const { data: pushToken } = await supabase
            .from('push_tokens')
            .select('token')
            .eq('user_id', user.id)
            .eq('enabled', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (pushToken?.token) {
            // Send push notification using Expo
            const message = {
              to: pushToken.token,
              sound: 'default',
              title: campaign.subject || campaign.name,
              body: campaign.content,
              data: { 
                campaignId: id,
                type: 'marketing_campaign'
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
      console.log(`📲 In-app notifications not yet implemented`)
    }

    // Save interaction records
    if (interactions.length > 0) {
      await supabase
        .from('user_campaign_interactions')
        .insert(interactions)
    }

    // Update analytics
    await supabase
      .from('campaign_analytics')
      .update({ 
        total_sent: sentCount,
        delivered: sentCount,
        updated_at: new Date().toISOString()
      })
      .eq('campaign_id', id)

    // Mark as sent
    await supabase
      .from('marketing_campaigns')
      .update({ status: 'sent' })
      .eq('id', id)

    console.log(`✅ Campaign ${id} sent to ${sentCount}/${users.length} users`)

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

    const { data, error } = await supabase
      .from('campaign_analytics')
      .select('*')
      .eq('campaign_id', id)
      .single()

    if (error) throw error

    // Get detailed interactions
    const { data: interactions } = await supabase
      .from('user_campaign_interactions')
      .select('action, created_at')
      .eq('campaign_id', id)

    res.json({
      ...data,
      interactions: interactions || []
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
    await supabase
      .from('user_campaign_interactions')
      .insert({
        campaign_id: id,
        user_id: userId as string,
        action: 'opened',
        created_at: new Date().toISOString()
      })

    // Update analytics
    const { data: analytics } = await supabase
      .from('campaign_analytics')
      .select('opened')
      .eq('campaign_id', id)
      .single()

    if (analytics) {
      await supabase
        .from('campaign_analytics')
        .update({ 
          opened: (analytics.opened || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('campaign_id', id)
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
      await supabase
        .from('user_campaign_interactions')
        .insert({
          campaign_id: id,
          user_id: userId as string,
          action: 'clicked',
          created_at: new Date().toISOString()
        })

      // Update analytics
      const { data: analytics } = await supabase
        .from('campaign_analytics')
        .select('clicked')
        .eq('campaign_id', id)
        .single()

      if (analytics) {
        await supabase
          .from('campaign_analytics')
          .update({ 
            clicked: (analytics.clicked || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('campaign_id', id)
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
  let query = supabase
    .from('profiles')
    .select('id, email, first_name')
    .is('deleted_at', null)
    .is('is_suspended', false)

  if (!criteria) {
    // No criteria, return all active users
    const { data } = await query
    return data || []
  }

  // Apply filters based on criteria
  if (criteria.gender) {
    query = query.eq('gender', criteria.gender)
  }

  if (criteria.age_min) {
    query = query.gte('age', criteria.age_min)
  }

  if (criteria.age_max) {
    query = query.lte('age', criteria.age_max)
  }

  if (criteria.location_city) {
    query = query.eq('location_city', criteria.location_city)
  }

  if (criteria.location_country) {
    query = query.eq('location_country', criteria.location_country)
  }

  if (criteria.interests && criteria.interests.length > 0) {
    query = query.contains('interests', criteria.interests)
  }

  const { data } = await query
  return data || []
}

export default router
