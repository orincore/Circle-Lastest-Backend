// Single source of truth for age math on the backend. `profiles.age` is a
// server-maintained derived column (see workers/age-resync.ts) - every write
// path computes it from date_of_birth via this file instead of trusting a
// client-supplied number.

export const MIN_AGE = 16

export function calculateAge(dateOfBirth: string | Date): number {
  const dob = typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : dateOfBirth
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const monthDiff = today.getMonth() - dob.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--
  }
  return age
}

export function isValidDateOfBirth(dateOfBirth: string | Date): boolean {
  const dob = typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : dateOfBirth
  if (Number.isNaN(dob.getTime())) return false
  if (dob.getTime() > Date.now()) return false
  return calculateAge(dob) >= MIN_AGE
}
