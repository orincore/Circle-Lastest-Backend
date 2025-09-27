export interface Message {
  id: string
  chatId: string
  senderId: string
  text: string
  createdAt: number
  deliveredBy?: string[]
  readBy?: string[]
}

const chats = new Map<string, Message[]>()
const typing = new Map<string, Set<string>>() // chatId -> set(userId)

export function getMessages(chatId: string): Message[] {
  return chats.get(chatId) ?? []
}

export function appendMessage(chatId: string, senderId: string, text: string): Message {
  const msg: Message = {
    id: `${chatId}_${Date.now()}`,
    chatId,
    senderId,
    text,
    createdAt: Date.now(),
    deliveredBy: [senderId],
    readBy: [],
  }
  const arr = chats.get(chatId) ?? []
  arr.push(msg)
  chats.set(chatId, arr)
  return msg
}

export function markDelivered(chatId: string, messageId: string, userId: string) {
  const arr = chats.get(chatId)
  if (!arr) return
  const m = arr.find((x) => x.id === messageId)
  if (!m) return
  m.deliveredBy = Array.from(new Set([...(m.deliveredBy ?? []), userId]))
}

export function markRead(chatId: string, messageId: string, userId: string) {
  const arr = chats.get(chatId)
  if (!arr) return
  const m = arr.find((x) => x.id === messageId)
  if (!m) return
  m.readBy = Array.from(new Set([...(m.readBy ?? []), userId]))
  // read implies delivered too
  m.deliveredBy = Array.from(new Set([...(m.deliveredBy ?? []), userId]))
}

export function setTyping(chatId: string, userId: string, isTyping: boolean) {
  const s = typing.get(chatId) ?? new Set<string>()
  if (isTyping) s.add(userId)
  else s.delete(userId)
  typing.set(chatId, s)
}

export function getTyping(chatId: string): string[] {
  return Array.from(typing.get(chatId) ?? new Set<string>())
}
