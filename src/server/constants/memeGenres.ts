// Single source of truth for meme genre tagging. Must stay in sync with the
// CHECK constraint on meme_genres.genre in migrations/055_create_user_meme_uploads.sql --
// clients never hardcode this list, they fetch it from GET /api/feed/genres.

export interface MemeGenre {
  value: string
  label: string
}

export const MEME_GENRES: MemeGenre[] = [
  { value: 'comedy', label: 'Comedy' },
  { value: 'relatable', label: 'Relatable' },
  { value: 'wholesome', label: 'Wholesome' },
  { value: 'dark_humor', label: 'Dark Humor' },
  { value: 'animals', label: 'Animals' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'anime', label: 'Anime' },
  { value: 'sports', label: 'Sports' },
  { value: 'desi', label: 'Desi' },
  { value: 'tech', label: 'Tech' },
  { value: 'politics', label: 'Politics' },
  { value: 'random', label: 'Random' },
]

export const MEME_GENRE_VALUES = new Set(MEME_GENRES.map((g) => g.value))

export const MIN_MEME_GENRES = 1
export const MAX_MEME_GENRES = 3
