import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { 
  getUserInbox, 
  getChatMessages, 
  insertMessage, 
  editMessage, 
  deleteMessage,
  addReaction,
  toggleReaction,
  removeReaction,
  getMessageReactions,
  getChatMuteSetting,
  setChatMuteSetting,
  isChatMuted
} from '../repos/chat.repo.js'

const router = Router()

router.get('/inbox', requireAuth, async (req: AuthRequest, res) => {
  const me = req.user!.id
  const inbox = await getUserInbox(me)
  res.json({ inbox })
})

router.get('/:chatId/messages', requireAuth, async (req: AuthRequest, res) => {
  const chatId = req.params.chatId
  const limit = Math.min(parseInt(String(req.query.limit || '30'), 10) || 30, 100)
  const before = (req.query.before as string | undefined) || undefined
  const list = await getChatMessages(chatId, limit, before)
  res.json({ messages: list })
})

router.post('/:chatId/messages', requireAuth, async (req: AuthRequest, res) => {
  const chatId = req.params.chatId
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'Message text is required' })
  const msg = await insertMessage(chatId, req.user!.id, text)
  res.json({ message: msg })
})

// Edit message
router.put('/messages/:messageId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const messageId = req.params.messageId
    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'Message text is required' })
    const msg = await editMessage(messageId, req.user!.id, text)
    res.json({ message: msg })
  } catch (error) {
    console.error('Edit message error:', error)
    res.status(500).json({ error: 'Failed to edit message' })
  }
})

// Delete message
router.delete('/:chatId/messages/:messageId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId, messageId } = req.params
    await deleteMessage(chatId, messageId, req.user!.id)
    res.json({ success: true })
  } catch (error) {
    console.error('Delete message error:', error)
    res.status(500).json({ error: 'Failed to delete message' })
  }
})

// Toggle reaction on message (WhatsApp style - same emoji toggles on/off)
router.post('/messages/:messageId/reactions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const messageId = req.params.messageId
    const emoji = String(req.body?.emoji || '').trim()
    if (!emoji) return res.status(400).json({ error: 'Emoji is required' })
    const result = await toggleReaction(messageId, req.user!.id, emoji)
    res.json({ action: result.action, reaction: result.reaction })
  } catch (error) {
    console.error('Toggle reaction error:', error)
    res.status(500).json({ error: 'Failed to toggle reaction. Make sure the message_reactions table exists.' })
  }
})

// Remove reaction from message
router.delete('/messages/:messageId/reactions/:emoji', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { messageId, emoji } = req.params
    await removeReaction(messageId, req.user!.id, decodeURIComponent(emoji))
    res.json({ success: true })
  } catch (error) {
    console.error('Remove reaction error:', error)
    res.status(500).json({ error: 'Failed to remove reaction' })
  }
})

// Get reactions for a message
router.get('/messages/:messageId/reactions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const messageId = req.params.messageId
    const reactions = await getMessageReactions(messageId)
    res.json({ reactions })
  } catch (error) {
    console.error('Get reactions error:', error)
    res.status(500).json({ error: 'Failed to get reactions' })
  }
})

// Get chat mute setting
router.get('/:chatId/mute', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params
    const userId = req.user!.id
    console.log('Getting mute setting for:', { userId, chatId })
    const setting = await getChatMuteSetting(userId, chatId)
    const muted = await isChatMuted(userId, chatId)
    console.log('Mute setting result:', { userId, chatId, muted, setting })
    res.json({ 
      isMuted: muted,
      setting: setting 
    })
  } catch (error) {
    console.error('Get mute setting error:', error)
    res.status(500).json({ error: 'Failed to get mute setting' })
  }
})

// Set chat mute setting
router.post('/:chatId/mute', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params
    const userId = req.user!.id
    const { isMuted, mutedUntil } = req.body
    
    console.log('Setting mute status:', { userId, chatId, isMuted, mutedUntil })
    
    if (typeof isMuted !== 'boolean') {
      return res.status(400).json({ error: 'isMuted must be a boolean' })
    }
    
    const setting = await setChatMuteSetting(userId, chatId, isMuted, mutedUntil)
    console.log('Mute setting saved:', setting)
    res.json({ setting })
  } catch (error) {
    console.error('Set mute setting error:', error)
    res.status(500).json({ error: 'Failed to set mute setting' })
  }
})

export default router
