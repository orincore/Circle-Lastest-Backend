// Mask name: "Adarsh Suradkar" -> "A***** S*******". Shared by blind-date
// (chat-list.routes.ts) and meme-connect (chat-list.routes.ts,
// meme-connect.routes.ts) anonymization so every still-anonymous chat reads
// identically, instead of meme-connect using a fixed generic label like
// "Anonymous connection".
function maskWord(word: string) {
  if (!word || word.length === 0) return ''
  if (word.length === 1) return word[0] + '*'
  return word[0] + '*'.repeat(word.length - 1)
}

export function maskFullName(firstName?: string | null, lastName?: string | null) {
  if (!firstName || !firstName.trim()) return 'Anonymous'
  const first = maskWord(firstName.trim())
  const last = lastName?.trim() ? maskWord(lastName.trim()) : ''
  return last ? `${first} ${last}` : first
}
