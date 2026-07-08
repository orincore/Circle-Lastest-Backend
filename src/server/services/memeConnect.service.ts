import { and, eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { memeConnectRequests, friendships, memeComments } from '../db/schema.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'
import { NotificationService } from './notificationService.js'

// In-app + push notification for meme-connect events. Deliberately carries
// NO sender_id and no name: meme comments are anonymous, so the notification
// must not leak who the other party is. Type reuses the generic
// 'profile_suggestion' (same precedent as announcements) because the shipped
// app doesn't know any meme-specific notification types. Failures are logged
// and swallowed — notifying must never break the connect flow itself.
async function notifyMemeConnect(recipientId: string, title: string, message: string, data: Record<string, any>) {
  try {
    await NotificationService.createNotification({
      recipient_id: recipientId,
      type: 'profile_suggestion',
      title,
      message,
      data: { action: 'meme_connect', ...data },
    })
  } catch (e) {
    console.error('meme connect notification failed:', e)
  }
}

export type ConnectRequestRow = typeof memeConnectRequests.$inferSelect

export class DuplicateRequestError extends Error {}
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}

async function createConnectRequest(
  requesterId: string,
  targetId: string,
  contextMemeId?: string | null
): Promise<ConnectRequestRow> {
  if (requesterId === targetId) {
    throw new ForbiddenError('Cannot send a connect request to yourself')
  }

  try {
    const [row] = await db
      .insert(memeConnectRequests)
      .values({ requesterId, targetId, contextMemeId: contextMemeId || null })
      .returning()

    await notifyMemeConnect(
      targetId,
      '🎭 Someone wants to connect!',
      'Someone liked your comment on a meme and wants to connect with you.',
      { requestId: row.id }
    )

    return row
  } catch (e: any) {
    if ((e?.code ?? e?.cause?.code) === '23505') {
      throw new DuplicateRequestError('A pending connect request between these two users already exists')
    }
    throw e
  }
}

/**
 * The only way a client can request a connection -- resolves the target user_id
 * and meme_id server-side from the comment itself. The client only ever knows a
 * comment's alias and id, never the commenter's real user_id (the comments API
 * never returns it); accepting a raw target_user_id from the client here would
 * mean either exposing real user_ids in the comments payload (defeating the
 * anonymity guarantee) or trusting a client-supplied id with no relation to
 * what the user actually saw.
 */
export async function createConnectRequestFromComment(
  requesterId: string,
  commentId: string
): Promise<ConnectRequestRow> {
  const [comment] = await db.select().from(memeComments).where(eq(memeComments.id, commentId)).limit(1)
  if (!comment) throw new NotFoundError('Comment not found')

  return createConnectRequest(requesterId, comment.userId, comment.memeId)
}

export async function listConnectRequests(userId: string) {
  const incoming = await db.select().from(memeConnectRequests).where(eq(memeConnectRequests.targetId, userId))
  const outgoing = await db.select().from(memeConnectRequests).where(eq(memeConnectRequests.requesterId, userId))
  return { incoming, outgoing }
}

export async function respondToConnectRequest(
  requestId: string,
  respondingUserId: string,
  accept: boolean
): Promise<ConnectRequestRow> {
  const [request] = await db.select().from(memeConnectRequests).where(eq(memeConnectRequests.id, requestId)).limit(1)
  if (!request) throw new NotFoundError('Connect request not found')
  if (request.targetId !== respondingUserId) throw new ForbiddenError('Only the recipient can respond to this request')
  if (request.status !== 'pending') throw new ForbiddenError(`Request is already ${request.status}`)

  if (!accept) {
    const [updated] = await db
      .update(memeConnectRequests)
      .set({ status: 'declined', respondedAt: new Date().toISOString() })
      .where(eq(memeConnectRequests.id, requestId))
      .returning()
    return updated
  }

  const chat = await ensureChatForUsers(request.requesterId, request.targetId)
  const [updated] = await db
    .update(memeConnectRequests)
    .set({ status: 'accepted', chatId: chat.id, respondedAt: new Date().toISOString() })
    .where(eq(memeConnectRequests.id, requestId))
    .returning()

  await notifyMemeConnect(
    request.requesterId,
    '🎉 Connect request accepted!',
    'Your meme connect request was accepted. Start chatting anonymously!',
    { requestId: updated.id, chatId: chat.id }
  )

  return updated
}

export async function requestReveal(requestId: string, userId: string): Promise<ConnectRequestRow> {
  const [request] = await db.select().from(memeConnectRequests).where(eq(memeConnectRequests.id, requestId)).limit(1)
  if (!request) throw new NotFoundError('Connect request not found')
  if (request.status !== 'accepted') throw new ForbiddenError('Can only reveal on an accepted connection')
  if (request.requesterId !== userId && request.targetId !== userId) {
    throw new ForbiddenError('Not a participant in this connection')
  }

  const update: Partial<typeof memeConnectRequests.$inferInsert> = {}
  if (request.requesterId === userId) update.requesterRevealed = true
  if (request.targetId === userId) update.targetRevealed = true

  const bothRevealed =
    (update.requesterRevealed ?? request.requesterRevealed) && (update.targetRevealed ?? request.targetRevealed)

  if (bothRevealed) {
    update.revealedAt = new Date().toISOString()
  }

  const [updated] = await db
    .update(memeConnectRequests)
    .set(update)
    .where(eq(memeConnectRequests.id, requestId))
    .returning()

  const otherUserId = request.requesterId === userId ? request.targetId : request.requesterId

  if (bothRevealed) {
    await createFriendshipIfMissing(request.requesterId, request.targetId)
    await Promise.all([
      notifyMemeConnect(
        request.requesterId,
        '🎉 Identities revealed!',
        'You both revealed your identities. Check out who you connected with!',
        { requestId: updated.id, chatId: updated.chatId }
      ),
      notifyMemeConnect(
        request.targetId,
        '🎉 Identities revealed!',
        'You both revealed your identities. Check out who you connected with!',
        { requestId: updated.id, chatId: updated.chatId }
      ),
    ])
  } else {
    await notifyMemeConnect(
      otherUserId,
      '🎭 Reveal request',
      'Your meme connection wants to reveal identities. Reveal yours too to see who they are!',
      { requestId: updated.id, chatId: updated.chatId }
    )
  }

  return updated
}

export async function isMemeConnectChat(chatId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memeConnectRequests.id })
    .from(memeConnectRequests)
    .where(and(eq(memeConnectRequests.chatId, chatId)))
    .limit(1)
  return !!row
}

async function createFriendshipIfMissing(userA: string, userB: string): Promise<boolean> {
  const smallerId = userA < userB ? userA : userB
  const largerId = userA < userB ? userB : userA

  const [existing] = await db
    .select({ id: friendships.id, status: friendships.status })
    .from(friendships)
    .where(and(eq(friendships.user1Id, smallerId), eq(friendships.user2Id, largerId)))
    .limit(1)

  if (existing) {
    if (existing.status !== 'active' && existing.status !== 'accepted') {
      await db.update(friendships).set({ status: 'accepted', updatedAt: new Date().toISOString() }).where(eq(friendships.id, existing.id))
    }
    return true
  }

  try {
    const now = new Date().toISOString()
    await db.insert(friendships).values({
      user1Id: smallerId,
      user2Id: largerId,
      senderId: userA,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })
    return true
  } catch (e: any) {
    if ((e?.code ?? e?.cause?.code) === '23505') return true
    throw e
  }
}
