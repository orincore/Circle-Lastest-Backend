import { findById, type Profile } from '../repos/profiles.repo.js'
import { emitToUser } from '../sockets/index.js'
import { supabase } from '../config/supabase.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'

type UserId = string

interface SearchState {
  userId: UserId
  startedAt: number
}

type ProposalId = string
interface Proposal {
  id: ProposalId
  a: UserId
  b: UserId
  createdAt: number
  expiresAt: number
  acceptedA: boolean
  acceptedB: boolean
  cancelled: boolean
}

const searching = new Map<UserId, SearchState>()
const proposals = new Map<ProposalId, Proposal>()
// cooldown key: `${min(a,b)}|${max(a,b)}` => timestamp until allowed again
const cooldown = new Map<string, number>()

function keyPair(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

// Helper function to check if user is already in an active proposal
function isUserInActiveProposal(userId: string): boolean {
  for (const p of proposals.values()) {
    if (!p.cancelled && Date.now() <= p.expiresAt && (p.a === userId || p.b === userId)) {
      return true
    }
  }
  return false
}

export async function startSearch(userId: string) {
  // Don't allow users to start searching if they're already in an active proposal
  if (isUserInActiveProposal(userId)) {
    console.log(`User ${userId} is already in an active proposal, cannot start new search`)
    return { searching: false, error: 'Already in an active match proposal' }
  }
  
  // Cancel any existing search for this user first
  searching.delete(userId)
  
  searching.set(userId, { userId, startedAt: Date.now() })
  console.log(`User ${userId} started searching for matches`)
  
  // attempt immediate pairing
  await tryPair(userId)
  return { searching: true }
}

export async function cancelSearch(userId: string) {
  searching.delete(userId)
}

export interface StatusResult {
  state: 'idle' | 'searching' | 'proposal' | 'matched' | 'cancelled'
  proposal?: { id: string; other: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'age' | 'gender' | 'interests' | 'needs' | 'profile_photo_url'>; acceptedByOther?: boolean; message?: string }
  match?: { otherName: string; chatId: string }
  message?: string
}

export async function getStatus(userId: string): Promise<StatusResult> {
  // find proposal where user is a participant
  for (const p of proposals.values()) {
    if (p.cancelled) continue
    if (p.a === userId || p.b === userId) {
      // expired proposals => clean up and resume searching
      if (Date.now() > p.expiresAt) {
        p.cancelled = true
        searching.set(p.a, { userId: p.a, startedAt: Date.now() })
        searching.set(p.b, { userId: p.b, startedAt: Date.now() })
        return { state: 'searching' }
      }
      const otherId = p.a === userId ? p.b : p.a
      const other = await findById(otherId)
      if (!other) return { state: 'searching' }

      if (p.acceptedA && p.acceptedB) {
        // matched!
        const otherName = `${other.first_name} ${other.last_name}`.trim()
        // we don't have chats implemented; fake a chat id
        const chatId = `chat_${p.id}`
        // cleanup
        proposals.delete(p.id)
        searching.delete(p.a)
        searching.delete(p.b)
        return { state: 'matched', match: { otherName, chatId }, message: `Hurrey! You got a match with ${otherName}` }
      }

      const acceptedByOther = (p.a === userId ? p.acceptedB : p.acceptedA)
      return {
        state: 'proposal',
        proposal: {
          id: p.id,
          other: {
            id: other.id,
            first_name: other.first_name,
            last_name: other.last_name,
            age: other.age,
            gender: other.gender,
            interests: other.interests,
            needs: other.needs,
            profile_photo_url: other.profile_photo_url,
          },
          acceptedByOther,
          message: acceptedByOther ? `${other.first_name} has accepted to chat. Waiting for you…` : undefined,
        },
      }
    }
  }

  if (searching.has(userId)) return { state: 'searching' }
  return { state: 'idle' }
}

export async function decide(userId: string, decision: 'accept' | 'pass'): Promise<StatusResult> {
  // find the active proposal for this user
  for (const p of proposals.values()) {
    if (p.cancelled) continue
    if (p.a === userId || p.b === userId) {
      if (decision === 'accept') {
        if (p.a === userId) p.acceptedA = true
        if (p.b === userId) p.acceptedB = true
        // Notify the other user that this user accepted
        const other = p.a === userId ? p.b : p.a
        try {
          const otherProfile = await findById(userId)
          if (otherProfile) emitToUser(other, 'matchmaking:accepted_by_other', { by: otherProfile.first_name })
        } catch {}

        // If both accepted, notify both with matched
        if (p.acceptedA && p.acceptedB) {
          const a = await findById(p.a)
          const b = await findById(p.b)
          const otherNameA = b ? `${b.first_name} ${b.last_name}`.trim() : 'Match'
          const otherNameB = a ? `${a.first_name} ${a.last_name}`.trim() : 'Match'
          // ensure DB chat exists and get chatId
          let chatId = ''
          try {
            const chat = await ensureChatForUsers(p.a, p.b)
            chatId = chat.id
          } catch {}
          proposals.delete(p.id)
          searching.delete(p.a)
          searching.delete(p.b)
          // update matchmaking history
          try {
            await supabase.from('matchmaking_history')
              .update({ accepted_a: true, accepted_b: true, matched_at: new Date().toISOString() })
              .eq('proposal_id', p.id)
          } catch {}
          try {
            emitToUser(p.a, 'matchmaking:matched', { chatId, otherName: otherNameA, message: `Hurrey! You got a match with ${otherNameA}` })
            emitToUser(p.b, 'matchmaking:matched', { chatId, otherName: otherNameB, message: `Hurrey! You got a match with ${otherNameB}` })
          } catch {}
          return { state: 'matched', match: { otherName: otherNameA, chatId }, message: `Hurrey! You got a match with ${otherNameA}` }
        }

        return getStatus(userId)
      } else {
        // apply cooldown and cancel for both
        p.cancelled = true
        const other = p.a === userId ? p.b : p.a
        cooldown.set(keyPair(userId, other), Date.now() + 60_000) // 60s
        searching.set(userId, { userId, startedAt: Date.now() })
        searching.set(other, { userId: other, startedAt: Date.now() })
        try {
          await supabase.from('matchmaking_history')
            .update({ cancelled_at: new Date().toISOString(), cancel_reason: 'pass' })
            .eq('proposal_id', p.id)
        } catch {}
        return { state: 'cancelled', message: 'Matchmaking cancelled by other user. Starting again…' }
      }
    }
  }
  return { state: 'idle' }
}

async function tryPair(userId: string) {
  const me = await findById(userId)
  if (!me) return

  // Don't try to pair users who are already in active proposals
  if (isUserInActiveProposal(userId)) {
    console.log(`User ${userId} is already in an active proposal, skipping pairing`)
    return
  }

  // Choose the best candidate among current searchers (excluding self and cooldown)
  let best: { otherId: string; score: number } | null = null

  for (const s of searching.values()) {
    const otherId = s.userId
    if (otherId === userId) continue
    
    // Skip users who are already in active proposals
    if (isUserInActiveProposal(otherId)) {
      console.log(`User ${otherId} is already in an active proposal, skipping`)
      continue
    }
    
    const coolKey = keyPair(userId, otherId)
    const until = cooldown.get(coolKey)
    if (until && Date.now() < until) continue

    const other = await findById(otherId)
    if (!other) continue

    const ageDiff = Math.abs((me.age ?? 0) - (other.age ?? 0))
    const mineInterests = Array.isArray(me.interests) ? me.interests : []
    const othInterests = Array.isArray(other.interests) ? other.interests : []
    const mineNeeds = Array.isArray(me.needs) ? me.needs : []
    const othNeeds = Array.isArray(other.needs) ? other.needs : []

    const interCount = mineInterests.filter((i) => othInterests.includes(i)).length
    const needsCount = mineNeeds.filter((n) => othNeeds.includes(n)).length

    // Score: overlaps are positive, age difference is a small penalty
    let score = interCount * 2 + needsCount * 1.5 - ageDiff * 0.2
    if (ageDiff <= 3) score += 2 // small bonus for close age

    if (!best || score > best.score) best = { otherId, score }
  }

  if (best) {
    const otherId = best.otherId
    
    // Double-check that neither user is in an active proposal before creating new one
    if (isUserInActiveProposal(userId) || isUserInActiveProposal(otherId)) {
      console.log(`One of the users (${userId}, ${otherId}) is already in an active proposal, aborting pairing`)
      return
    }
    
    const id = `${userId.slice(0, 6)}_${otherId.slice(0, 6)}_${Date.now()}`
    const p: Proposal = {
      id,
      a: userId,
      b: otherId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 90_000,
      acceptedA: false,
      acceptedB: false,
      cancelled: false,
    }
    proposals.set(id, p)
    searching.delete(userId)
    searching.delete(otherId)
    
    console.log(`Created proposal ${id} between users ${userId} and ${otherId}`)
    
    // Notify both users a proposal is ready
    try {
      const a = await findById(p.a)
      const b = await findById(p.b)
      if (a && b) {
        // insert matchmaking history record
        try {
          await supabase.from('matchmaking_history').insert({ proposal_id: id, user_a: p.a, user_b: p.b })
        } catch {}
        emitToUser(p.a, 'matchmaking:proposal', {
          id: p.id,
          other: { id: b.id, first_name: b.first_name, last_name: b.last_name, age: b.age, gender: b.gender, interests: b.interests, needs: b.needs, profile_photo_url: b.profile_photo_url }
        })
        emitToUser(p.b, 'matchmaking:proposal', {
          id: p.id,
          other: { id: a.id, first_name: a.first_name, last_name: a.last_name, age: a.age, gender: a.gender, interests: a.interests, needs: a.needs, profile_photo_url: a.profile_photo_url }
        })
      }
    } catch {}
  }
}

export async function heartbeat() {
  // Cleanup expired cooldowns and proposals occasionally (can be called by a timer in server bootstrap)
  const now = Date.now()
  for (const [k, v] of cooldown.entries()) if (v < now) cooldown.delete(k)
  
  // Clean up expired proposals and put users back in searching if needed
  for (const [id, p] of proposals.entries()) {
    if (p.expiresAt < now) {
      console.log(`Proposal ${id} expired, putting users back in searching`)
      proposals.delete(id)
      // Put both users back in searching if they're not already matched
      if (!p.acceptedA || !p.acceptedB) {
        searching.set(p.a, { userId: p.a, startedAt: now })
        searching.set(p.b, { userId: p.b, startedAt: now })
      }
    }
  }

  // Proactively try to pair any searching users (but only those not in active proposals)
  const ids = Array.from(searching.keys())
  for (const uid of ids) {
    // Searching map may shrink during iteration as we create proposals
    if (searching.has(uid) && !isUserInActiveProposal(uid)) {
      try { 
        await tryPair(uid) 
      } catch (error) {
        console.error(`Error trying to pair user ${uid}:`, error)
      }
    }
  }
}
