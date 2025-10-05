import { Router } from 'express'
import { supabase } from '../config/supabase.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'

const router = Router()

// Get all notification templates
router.get('/notifications', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { category } = req.query

    let query = supabase
      .from('notification_templates')
      .select('*')
      .order('created_at', { ascending: false })

    if (category && category !== 'all') {
      query = query.eq('category', category)
    }

    const { data, error } = await query

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Error fetching notification templates:', error)
    res.status(500).json({ error: 'Failed to fetch templates' })
  }
})

// Create notification template
router.post('/notifications', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { name, title, body, category, icon, image_url, deep_link, variables } = req.body
    const userId = req.user!.id

    if (!name || !title || !body) {
      return res.status(400).json({ error: 'Name, title, and body are required' })
    }

    const { data, error } = await supabase
      .from('notification_templates')
      .insert({
        name,
        title,
        body,
        category,
        icon,
        image_url,
        deep_link,
        variables,
        created_by: userId
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (error) {
    console.error('Error creating notification template:', error)
    res.status(500).json({ error: 'Failed to create template' })
  }
})

// Update notification template
router.put('/notifications/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const updates = req.body

    const { data, error } = await supabase
      .from('notification_templates')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json(data)
  } catch (error) {
    console.error('Error updating notification template:', error)
    res.status(500).json({ error: 'Failed to update template' })
  }
})

// Delete notification template
router.delete('/notifications/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('notification_templates')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting notification template:', error)
    res.status(500).json({ error: 'Failed to delete template' })
  }
})

// Get all email templates
router.get('/emails', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { category } = req.query

    let query = supabase
      .from('email_templates')
      .select('*')
      .order('created_at', { ascending: false })

    if (category && category !== 'all') {
      query = query.eq('category', category)
    }

    const { data, error } = await query

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Error fetching email templates:', error)
    res.status(500).json({ error: 'Failed to fetch templates' })
  }
})

// Create email template
router.post('/emails', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { name, subject, html_content, text_content, category, variables, preview_text } = req.body
    const userId = req.user!.id

    if (!name || !subject || !html_content) {
      return res.status(400).json({ error: 'Name, subject, and html_content are required' })
    }

    const { data, error } = await supabase
      .from('email_templates')
      .insert({
        name,
        subject,
        html_content,
        text_content,
        category,
        variables,
        preview_text,
        created_by: userId
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (error) {
    console.error('Error creating email template:', error)
    res.status(500).json({ error: 'Failed to create template' })
  }
})

export default router
