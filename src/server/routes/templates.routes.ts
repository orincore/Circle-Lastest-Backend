import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { desc, eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { emailTemplates, notificationTemplates } from '../db/schema.js'

const router = Router()

function rowToNotificationTemplate(row: typeof notificationTemplates.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    body: row.body,
    category: row.category,
    icon: row.icon,
    image_url: row.imageUrl,
    deep_link: row.deepLink,
    variables: row.variables,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function rowToEmailTemplate(row: typeof emailTemplates.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    html_content: row.htmlContent,
    text_content: row.textContent,
    category: row.category,
    variables: row.variables,
    preview_text: row.previewText,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// Get all notification templates
router.get('/notifications', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { category } = req.query

    const condition = category && category !== 'all' ? eq(notificationTemplates.category, category as string) : undefined

    const rows = await db.select().from(notificationTemplates).where(condition).orderBy(desc(notificationTemplates.createdAt))

    res.json(rows.map(rowToNotificationTemplate))
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

    const rows = await db.insert(notificationTemplates).values({
      name,
      title,
      body,
      category,
      icon,
      imageUrl: image_url,
      deepLink: deep_link,
      variables,
      createdBy: userId,
    }).returning()

    res.status(201).json(rowToNotificationTemplate(rows[0]))
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

    const setData: Partial<typeof notificationTemplates.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    }
    if (updates.name !== undefined) setData.name = updates.name
    if (updates.title !== undefined) setData.title = updates.title
    if (updates.body !== undefined) setData.body = updates.body
    if (updates.category !== undefined) setData.category = updates.category
    if (updates.icon !== undefined) setData.icon = updates.icon
    if (updates.image_url !== undefined) setData.imageUrl = updates.image_url
    if (updates.deep_link !== undefined) setData.deepLink = updates.deep_link
    if (updates.variables !== undefined) setData.variables = updates.variables
    if (updates.created_by !== undefined) setData.createdBy = updates.created_by

    const rows = await db.update(notificationTemplates).set(setData).where(eq(notificationTemplates.id, id)).returning()

    res.json(rowToNotificationTemplate(rows[0]))
  } catch (error) {
    console.error('Error updating notification template:', error)
    res.status(500).json({ error: 'Failed to update template' })
  }
})

// Delete notification template
router.delete('/notifications/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    await db.delete(notificationTemplates).where(eq(notificationTemplates.id, id))

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

    const condition = category && category !== 'all' ? eq(emailTemplates.category, category as string) : undefined

    const rows = await db.select().from(emailTemplates).where(condition).orderBy(desc(emailTemplates.createdAt))

    res.json(rows.map(rowToEmailTemplate))
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

    const rows = await db.insert(emailTemplates).values({
      name,
      subject,
      htmlContent: html_content,
      textContent: text_content,
      category,
      variables,
      previewText: preview_text,
      createdBy: userId,
    }).returning()

    res.status(201).json(rowToEmailTemplate(rows[0]))
  } catch (error) {
    console.error('Error creating email template:', error)
    res.status(500).json({ error: 'Failed to create template' })
  }
})

export default router
