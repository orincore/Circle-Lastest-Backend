# Batch 1: Auth & Profiles Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the first migration batch — auth middleware, admin-role checks, profile verification checks, the profiles repo, and the profile-touching parts of the GraphQL resolvers and auth routes — from `supabase-js` to Drizzle ORM against the local Postgres replica, with zero behavior change for every other file that still imports these functions.

**Architecture:** `profiles.repo.ts` becomes the canonical Drizzle-backed data-access layer for the `profiles` table; every other file in this batch either calls into it or does its own small, targeted Drizzle query for `admin_roles`/`admin_audit_logs`. Because ~70 other files across the codebase are not yet migrated and still import functions from `profiles.repo.ts` expecting the existing snake_case `Profile` shape, every read path maps Drizzle's camelCase rows back to that exact shape before returning — this repo's public interface does not change, only its internals.

**Tech Stack:** `drizzle-orm` (already installed, Phase 0), the `db` client and `profiles`/`adminRoles`/`adminAuditLogs` tables from `src/server/db/schema.ts` (already introspected, Phase 0).

## Global Constraints

- **The `Profile` interface (snake_case: `first_name`, `password_hash`, etc.) does not change.** It's consumed by ~70 files outside this batch. Drizzle's schema properties are camelCase (`firstName`, `passwordHash`) because that's what `drizzle-kit pull` generated — every function that returns a `Profile` must map camelCase → snake_case before returning. This is the pattern every future migration batch's repo file will reuse.
- `profiles.latitude` / `profiles.longitude` are Postgres `numeric` columns. Drizzle's TS type for them is `string` (avoids float precision loss) — the existing `Profile` interface types them as `number`, so every read converts with `Number(row.latitude)` and every write converts back with `String(value)`.
- Project uses TypeScript with `"module": "NodeNext"` — relative imports need explicit `.js` extensions (e.g. `from '../config/db.js'`), matching the existing codebase pattern.
- The Drizzle client (`db`) is exported from `src/server/config/db.ts`; the schema tables are exported from `src/server/db/schema.ts` (e.g. `import { profiles, adminRoles, adminAuditLogs } from '../db/schema.js'`).
- No automated test suite exists in this project — verification is running the dev server locally against local Postgres and manually exercising each endpoint with `curl`, matching current project practice.
- **Testing uses existing seeded data, not fresh writes, for cross-checking.** Local Postgres and Supabase currently hold identical data (from Phase 0's one-time replication) — but only local Postgres is being written to by this batch's migrated code. Any *new* row created while testing (e.g. a fresh signup) will exist in local Postgres only, not in Supabase — that's expected and fine (Supabase becomes irrelevant after the eventual full cutover), just don't expect it to show up if you ever check Supabase directly.
- **Known pre-existing dead code, preserve as-is:** `routes/auth.routes.ts`'s `/delete-account` endpoint inserts into a table called `user_activity`, which does not exist anywhere in the schema (the real tables are `user_activities` and `user_activity_events` — neither is an exact match). This insert is wrapped in a try/catch that already silently swallows the failure in production today. Task 5 preserves this exact behavior (still fails, still silently caught) via a raw SQL passthrough rather than guessing which real table was intended — that's a product decision for the person who owns this code, not something to silently "fix" mid-migration.
- `find_nearby_users` is a real Postgres function (confirmed present in the local restore, Phase 0) with signature `find_nearby_users(user_lat numeric, user_lng numeric, radius_km numeric DEFAULT 50, exclude_user_id uuid DEFAULT NULL, result_limit integer DEFAULT 100)`, returning a table of profile columns plus `distance`. Called via `db.execute(sql\`select * from find_nearby_users(...)\`)`, which returns raw driver rows with the actual snake_case column names (unlike the Drizzle query builder, which returns camelCase) — no case-mapping needed for that path specifically.

---

### Task 1: Migrate `profiles.repo.ts` to Drizzle

**Files:**
- Modify: `src/server/repos/profiles.repo.ts` (full rewrite of the query internals; the exported `Profile` interface and every function's name/signature stay identical)

**Interfaces:**
- Consumes: `db` from `src/server/config/db.ts`; `profiles` table from `src/server/db/schema.ts`.
- Produces: same exports as before — `Profile`, `findByEmail`, `findByUsername`, `createProfile`, `findById`, `updateLocation`, `updatePreferences`, `findNearbyUsers`, `findUsersInArea` — plus a newly-exported `rowToProfile(row: typeof profiles.$inferSelect): Profile` mapper that Task 4 (`graphql/resolvers.ts`) imports and reuses.

- [ ] **Step 1: Replace the file**

Replace the full contents of `src/server/repos/profiles.repo.ts` with:

```ts
import { and, eq, gte, ilike, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'

export interface Profile {
  id: string
  email: string
  username: string
  first_name: string
  last_name: string
  age: number
  gender: string
  phone_number?: string | null
  about: string
  interests: string[]
  needs: string[]
  profile_photo_url?: string | null
  instagram_username?: string | null
  password_hash: string
  email_verified?: boolean | null
  email_verified_at?: string | null
  verification_status?: string | null
  verified_at?: string | null
  latitude?: number | null
  longitude?: number | null
  location_address?: string | null
  location_city?: string | null
  location_country?: string | null
  location_updated_at?: string | null
  location_preference?: string | null
  age_preference?: string | null
  friendship_location_priority?: boolean | null
  relationship_distance_flexible?: boolean | null
  preferences_updated_at?: string | null
  invisible_mode?: boolean | null
  is_suspended?: boolean | null
  suspension_reason?: string | null
  suspended_at?: string | null
  suspension_ends_at?: string | null
  deleted_at?: string | null
  deletion_reason?: string | null
  deletion_feedback?: string | null
  created_at?: string
}

type ProfileRow = typeof profiles.$inferSelect

/**
 * Bridges Drizzle's camelCase row shape back to the snake_case `Profile` shape
 * every other file in the codebase expects (unchanged since the supabase-js days).
 * Every future migration batch's repo file follows this same pattern.
 */
export function rowToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    first_name: row.firstName,
    last_name: row.lastName,
    age: row.age,
    gender: row.gender,
    phone_number: row.phoneNumber,
    about: row.about,
    interests: row.interests,
    needs: row.needs,
    profile_photo_url: row.profilePhotoUrl,
    instagram_username: row.instagramUsername,
    password_hash: row.passwordHash,
    email_verified: row.emailVerified,
    email_verified_at: row.emailVerifiedAt,
    verification_status: row.verificationStatus,
    verified_at: row.verifiedAt,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    location_address: row.locationAddress,
    location_city: row.locationCity,
    location_country: row.locationCountry,
    location_updated_at: row.locationUpdatedAt,
    location_preference: row.locationPreference,
    age_preference: row.agePreference,
    friendship_location_priority: row.friendshipLocationPriority,
    relationship_distance_flexible: row.relationshipDistanceFlexible,
    preferences_updated_at: row.preferencesUpdatedAt,
    invisible_mode: row.invisibleMode,
    is_suspended: row.isSuspended,
    suspension_reason: row.suspensionReason,
    suspended_at: row.suspendedAt,
    suspension_ends_at: row.suspensionEndsAt,
    deleted_at: row.deletedAt,
    deletion_reason: row.deletionReason,
    deletion_feedback: row.deletionFeedback,
    created_at: row.createdAt ?? undefined,
  }
}

export async function findByEmail(email: string): Promise<Profile | null> {
  const rows = await db.select().from(profiles).where(eq(profiles.email, email)).limit(1)
  return rows[0] ? rowToProfile(rows[0]) : null
}

export async function findByUsername(username: string): Promise<Profile | null> {
  // Search case-insensitively, same as the original `.ilike('username', username)`
  const rows = await db.select().from(profiles).where(ilike(profiles.username, username)).limit(1)
  return rows[0] ? rowToProfile(rows[0]) : null
}

export async function createProfile(p: Omit<Profile, 'id' | 'created_at'>): Promise<Profile> {
  const rows = await db.insert(profiles).values({
    email: p.email,
    username: p.username,
    firstName: p.first_name,
    lastName: p.last_name,
    age: p.age,
    gender: p.gender,
    phoneNumber: p.phone_number ?? null,
    about: p.about,
    interests: p.interests,
    needs: p.needs,
    profilePhotoUrl: p.profile_photo_url ?? null,
    instagramUsername: p.instagram_username ?? null,
    passwordHash: p.password_hash,
  }).returning()
  return rowToProfile(rows[0])
}

export async function findById(id: string): Promise<Profile | null> {
  const rows = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1)
  return rows[0] ? rowToProfile(rows[0]) : null
}

export async function updateLocation(id: string, location: {
  latitude: number
  longitude: number
  address?: string
  city?: string
  country?: string
}): Promise<Profile> {
  const rows = await db.update(profiles).set({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    locationAddress: location.address || null,
    locationCity: location.city || null,
    locationCountry: location.country || null,
    locationUpdatedAt: new Date().toISOString(),
  }).where(eq(profiles.id, id)).returning()
  return rowToProfile(rows[0])
}

export async function updatePreferences(id: string, preferences: {
  locationPreference?: string
  agePreference?: string
  friendshipLocationPriority?: boolean
  relationshipDistanceFlexible?: boolean
}): Promise<Profile> {
  const updateData: Record<string, unknown> = {
    preferencesUpdatedAt: new Date().toISOString(),
  }
  if (preferences.locationPreference !== undefined) updateData.locationPreference = preferences.locationPreference
  if (preferences.agePreference !== undefined) updateData.agePreference = preferences.agePreference
  if (preferences.friendshipLocationPriority !== undefined) updateData.friendshipLocationPriority = preferences.friendshipLocationPriority
  if (preferences.relationshipDistanceFlexible !== undefined) updateData.relationshipDistanceFlexible = preferences.relationshipDistanceFlexible

  const rows = await db.update(profiles).set(updateData).where(eq(profiles.id, id)).returning()
  return rowToProfile(rows[0])
}

interface NearbyUserRow {
  id: string; email: string; username: string; first_name: string; last_name: string
  age: number; gender: string; phone_number: string | null; about: string
  interests: string[]; needs: string[]; profile_photo_url: string | null
  instagram_username: string | null; password_hash: string
  email_verified: boolean | null; email_verified_at: string | null
  verification_status: string | null; verification_required: boolean | null
  verified_at: string | null; latitude: string | null; longitude: string | null
  location_address: string | null; location_city: string | null; location_country: string | null
  location_updated_at: string | null; location_preference: string | null; age_preference: string | null
  friendship_location_priority: boolean | null; relationship_distance_flexible: boolean | null
  preferences_updated_at: string | null; invisible_mode: boolean | null
  created_at: string | null; distance: string
}

// Find nearby users within a radius (in kilometers)
export async function findNearbyUsers({
  latitude,
  longitude,
  radiusKm = 50,
  excludeUserId,
  limit = 100
}: {
  latitude: number
  longitude: number
  radiusKm?: number
  excludeUserId?: string
  limit?: number
}): Promise<(Profile & { distance: number })[]> {
  try {
    const result = await db.execute<NearbyUserRow>(
      sql`select * from find_nearby_users(${latitude}, ${longitude}, ${radiusKm}, ${excludeUserId ?? null}, ${limit})`
    )

    // Filter out users without complete profiles and invisible users (matches original RPC-path filtering)
    return result.rows
      .filter((u) => u.first_name && u.last_name && (!u.invisible_mode || u.invisible_mode === false))
      .map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        first_name: u.first_name,
        last_name: u.last_name,
        age: u.age,
        gender: u.gender,
        phone_number: u.phone_number,
        about: u.about,
        interests: u.interests,
        needs: u.needs,
        profile_photo_url: u.profile_photo_url,
        instagram_username: u.instagram_username,
        password_hash: u.password_hash,
        email_verified: u.email_verified,
        email_verified_at: u.email_verified_at,
        verification_status: u.verification_status,
        verified_at: u.verified_at,
        latitude: u.latitude !== null ? Number(u.latitude) : null,
        longitude: u.longitude !== null ? Number(u.longitude) : null,
        location_address: u.location_address,
        location_city: u.location_city,
        location_country: u.location_country,
        location_updated_at: u.location_updated_at,
        location_preference: u.location_preference,
        age_preference: u.age_preference,
        friendship_location_priority: u.friendship_location_priority,
        relationship_distance_flexible: u.relationship_distance_flexible,
        preferences_updated_at: u.preferences_updated_at,
        invisible_mode: u.invisible_mode,
        created_at: u.created_at ?? undefined,
        distance: Number(u.distance),
      }))
  } catch {
    // Fallback to basic query if the RPC function doesn't exist (matches original fallback behavior)
    const rows = await db.select().from(profiles).where(and(
      isNotNull(profiles.latitude),
      isNotNull(profiles.longitude),
      isNotNull(profiles.firstName),
      isNotNull(profiles.lastName),
      ne(profiles.id, excludeUserId || ''),
      or(isNull(profiles.invisibleMode), eq(profiles.invisibleMode, false)),
      eq(profiles.isSuspended, false),
      isNull(profiles.deletedAt),
    )).limit(limit)

    return rows
      .map((row) => {
        const p = rowToProfile(row)
        return { ...p, distance: calculateDistance(latitude, longitude, p.latitude!, p.longitude!) }
      })
      .filter((user) => user.distance <= radiusKm)
  }
}

// Find users within a bounding box (for map viewport)
export async function findUsersInArea({
  northEast,
  southWest,
  excludeUserId,
  limit = 100
}: {
  northEast: { latitude: number; longitude: number }
  southWest: { latitude: number; longitude: number }
  excludeUserId?: string
  limit?: number
}): Promise<Profile[]> {
  const rows = await db.select().from(profiles).where(and(
    gte(profiles.latitude, String(southWest.latitude)),
    lte(profiles.latitude, String(northEast.latitude)),
    gte(profiles.longitude, String(southWest.longitude)),
    lte(profiles.longitude, String(northEast.longitude)),
    isNotNull(profiles.latitude),
    isNotNull(profiles.longitude),
    ne(profiles.id, excludeUserId || ''),
    or(isNull(profiles.invisibleMode), eq(profiles.invisibleMode, false)),
    eq(profiles.isSuspended, false),
    isNull(profiles.deletedAt),
  )).limit(limit)

  // Additional filter for safety (matches original)
  return rows.map(rowToProfile).filter((user) => !user.is_suspended && !user.deleted_at)
}

// Helper function to calculate distance between two points
function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371 // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Manual smoke test against real data**

Make sure the app's `DATABASE_URL` points at local Postgres (it does, from Phase 0's `.env` setup). Run a quick script to prove the migrated repo works against real replicated data:

```bash
npx tsx -e "
import { findByEmail, findById } from './src/server/repos/profiles.repo.js'
const all = await import('./src/server/config/db.js')
const { profiles } = await import('./src/server/db/schema.js')
const rows = await all.db.select({ id: profiles.id, email: profiles.email }).from(profiles).limit(1)
const row = rows[0]
console.log('Sample profile:', row)
const byId = await findById(row.id)
console.log('findById shape check - has first_name key:', 'first_name' in (byId || {}), 'value:', byId?.first_name)
const byEmail = await findByEmail(row.email)
console.log('findByEmail matches findById:', byEmail?.id === byId?.id)
process.exit(0)
"
```
Expected: prints a real profile id/email, confirms `first_name` key is present (not `firstName`) with a real value, and `findByEmail` returns the same id as `findById`.

- [ ] **Step 4: Commit**

```bash
git add src/server/repos/profiles.repo.ts
git commit -m "feat: migrate profiles.repo.ts from supabase-js to Drizzle"
```

---

### Task 2: Migrate admin-role checks (`middleware/auth.ts` + `middleware/adminAuth.ts`) to Drizzle

**Files:**
- Modify: `src/server/middleware/auth.ts:126-155` (the `requireAdmin` function only — the rest of the file, `requireAuth`, is pure JWT verification with no database access and does not change)
- Modify: `src/server/middleware/adminAuth.ts` (every `supabase.from('admin_roles'|'admin_audit_logs')` call)

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `adminRoles`, `adminAuditLogs` from `../db/schema.js`.
- Produces: same exports as before, same behavior — `requireAdmin` (both versions — yes, two different files each export a function with this name for different purposes, that's pre-existing, not something this task changes), `requireRole`, `logAdminAction`, `requireSuperAdmin`, `requireModerator`, `requireAnyAdmin`, `isAdmin`, `getAdminRole`, `grantAdminRole`, `revokeAdminRole`.

- [ ] **Step 1: Migrate `middleware/auth.ts`'s `requireAdmin`**

In `src/server/middleware/auth.ts`, add this import near the top of the file (after the existing imports):

```ts
import { eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { adminRoles } from '../db/schema.js'
```

Replace the body of `requireAdmin` (currently lines 127-155) with:

```ts
export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Authentication required' })
    }

    // Check if user has admin role
    const rows = await db.select({ role: adminRoles.role }).from(adminRoles).where(eq(adminRoles.userId, req.user.id)).limit(1)
    const adminRole = rows[0]

    if (!adminRole) {
      logger.warn(`Unauthorized admin access attempt by user: ${req.user.id}`)
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Admin access required' })
    }

    // Attach admin role to request
    req.user = { ...req.user, role: adminRole.role }

    //console.log('✅ Admin auth successful - User ID:', req.user.id, 'Role:', adminRole.role)
    return next()
  } catch (e) {
    logger.error({ userId: req.user?.id, error: e }, 'Admin authorization error')
    return res.status(StatusCodes.FORBIDDEN).json({ error: 'Admin access denied' })
  }
}
```

(This drops the dynamic `await import('../config/supabase.js')` in favor of a static import — a plain simplification with no behavior change, since there's no circular-import reason for it to be dynamic here.)

- [ ] **Step 2: Migrate `middleware/adminAuth.ts`**

Replace the `import { supabase } from '../config/supabase.js'` line at the top of `src/server/middleware/adminAuth.ts` with:

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../config/db.js'
import { adminRoles, adminAuditLogs } from '../db/schema.js'
```

Replace the query in `requireAdmin` (currently):
```ts
    const { data: adminRole, error } = await supabase
      .from('admin_roles')
      .select('id, role, granted_at, is_active')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null)
      .single()

    if (error || !adminRole) {
```
with:
```ts
    const rows = await db.select({
      id: adminRoles.id,
      role: adminRoles.role,
      grantedAt: adminRoles.grantedAt,
      isActive: adminRoles.isActive,
    }).from(adminRoles).where(and(
      eq(adminRoles.userId, userId),
      eq(adminRoles.isActive, true),
      isNull(adminRoles.revokedAt),
    )).limit(1)
    const adminRole = rows[0]

    if (!adminRole) {
```
and update the one place that reads `adminRole.granted_at` (in the `req.admin = { ... }` assignment a few lines below) to `adminRole.grantedAt` instead (camelCase — this is a local variable inside this file, not the shared `Profile` interface, so it doesn't need a snake_case bridge; just match Drizzle's actual property name directly).

Replace the query in `logAdminAction` (currently):
```ts
    const { error } = await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: adminId,
        action,
        target_type: targetType,
        target_id: targetId,
        details,
        ip_address: details.ip || null,
        user_agent: details.userAgent || null
      })

    if (error) {
      console.error('Failed to log admin action:', error)
    }
```
with:
```ts
    await db.insert(adminAuditLogs).values({
      adminId,
      action,
      targetType,
      targetId,
      details,
      ipAddress: details.ip || null,
      userAgent: details.userAgent || null,
    })
```
(Drop the `if (error)` branch — Drizzle throws on failure rather than returning an `{ error }` object, and the whole call is already wrapped in this function's outer `try`/`catch`, which logs `'Error logging admin action:'` on any thrown error, preserving the same "log and don't crash the caller" behavior.)

Replace the query in `isAdmin` (currently):
```ts
    const { data, error } = await supabase
      .from('admin_roles')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null)
      .single()

    return !error && !!data
```
with:
```ts
    const rows = await db.select({ id: adminRoles.id }).from(adminRoles).where(and(
      eq(adminRoles.userId, userId),
      eq(adminRoles.isActive, true),
      isNull(adminRoles.revokedAt),
    )).limit(1)

    return rows.length > 0
```

Replace the query in `getAdminRole` (currently):
```ts
    const { data, error } = await supabase
      .from('admin_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null)
      .single()

    if (error || !data) {
      return null
    }

    return data.role
```
with:
```ts
    const rows = await db.select({ role: adminRoles.role }).from(adminRoles).where(and(
      eq(adminRoles.userId, userId),
      eq(adminRoles.isActive, true),
      isNull(adminRoles.revokedAt),
    )).limit(1)

    if (!rows[0]) {
      return null
    }

    return rows[0].role as 'super_admin' | 'moderator' | 'support'
```

Replace the query in `grantAdminRole` (currently):
```ts
    const { error } = await supabase
      .from('admin_roles')
      .insert({
        user_id: userId,
        role,
        granted_by: grantedBy
      })

    if (error) {
      console.error('Error granting admin role:', error)
      return {
        success: false,
        error: 'Failed to grant admin role'
      }
    }
```
with:
```ts
    try {
      await db.insert(adminRoles).values({
        userId,
        role,
        grantedBy,
      })
    } catch (error) {
      console.error('Error granting admin role:', error)
      return {
        success: false,
        error: 'Failed to grant admin role'
      }
    }
```

Replace the query in `revokeAdminRole` (currently):
```ts
    const { error } = await supabase
      .from('admin_roles')
      .update({
        is_active: false,
        revoked_at: new Date().toISOString()
      })
      .eq('user_id', userId)

    if (error) {
      console.error('Error revoking admin role:', error)
      return {
        success: false,
        error: 'Failed to revoke admin role'
      }
    }
```
with:
```ts
    try {
      await db.update(adminRoles).set({
        isActive: false,
        revokedAt: new Date().toISOString(),
      }).where(eq(adminRoles.userId, userId))
    } catch (error) {
      console.error('Error revoking admin role:', error)
      return {
        success: false,
        error: 'Failed to revoke admin role'
      }
    }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Manual smoke test against real data**

Find a real admin user id from the local restore and confirm the migrated checks agree with what's actually in the table:

```bash
npx tsx -e "
import { db } from './src/server/config/db.js'
import { adminRoles } from './src/server/db/schema.js'
import { isAdmin, getAdminRole } from './src/server/middleware/adminAuth.js'

const rows = await db.select().from(adminRoles).limit(1)
if (!rows[0]) { console.log('No admin_roles rows exist locally - skipping (nothing to verify against)'); process.exit(0) }
const row = rows[0]
console.log('Sample admin_roles row:', row)
console.log('isAdmin(user):', await isAdmin(row.userId))
console.log('getAdminRole(user):', await getAdminRole(row.userId))
process.exit(0)
"
```
Expected: if `admin_roles` has at least one row, `isAdmin` returns `true` and `getAdminRole` returns the same role stored in the row (assuming that row has `is_active = true` and `revoked_at = null` — if the one found row doesn't, note that in your report rather than treating it as a failure).

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/auth.ts src/server/middleware/adminAuth.ts
git commit -m "feat: migrate admin-role checks in auth.ts and adminAuth.ts to Drizzle"
```

---

### Task 3: Migrate `middleware/requireVerification.ts` to Drizzle

**Files:**
- Modify: `src/server/middleware/requireVerification.ts`

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `profiles` from `../db/schema.js`.
- Produces: same exports as before, same behavior — `requireVerification`, `checkVerification`.

- [ ] **Step 1: Replace the file**

Replace the full contents of `src/server/middleware/requireVerification.ts` with:

```ts
import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { AuthRequest } from './auth.js';
import { db } from '../config/db.js';
import { profiles } from '../db/schema.js';

/**
 * Middleware to require face verification
 * Blocks access to protected routes until user is verified
 */
export async function requireVerification(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get user's verification status
    const rows = await db.select({
      verificationStatus: profiles.verificationStatus,
      verificationRequired: profiles.verificationRequired,
    }).from(profiles).where(eq(profiles.id, userId)).limit(1);
    const profile = rows[0];

    if (!profile) {
      console.error('Error checking verification status: profile not found for user', userId);
      return res.status(500).json({ error: 'Failed to check verification status' });
    }

    // If verification not required, allow access
    if (!profile.verificationRequired) {
      return next();
    }

    // Check if user is verified
    if (profile.verificationStatus === 'verified') {
      return next();
    }

    // User not verified - block access
    return res.status(403).json({
      error: 'Verification required',
      message: 'Please complete face verification to access this feature',
      verification_status: profile.verificationStatus,
      verification_required: true
    });

  } catch (error) {
    console.error('Error in requireVerification middleware:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Optional verification check - doesn't block but adds verification info to request
 */
export async function checkVerification(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user?.id;

    if (userId) {
      const rows = await db.select({
        verificationStatus: profiles.verificationStatus,
        verificationRequired: profiles.verificationRequired,
      }).from(profiles).where(eq(profiles.id, userId)).limit(1);
      const profile = rows[0];

      if (profile) {
        req.verificationStatus = profile.verificationStatus ?? undefined;
        req.verificationRequired = profile.verificationRequired ?? undefined;
      }
    }

    next();
  } catch (error) {
    console.error('Error in checkVerification middleware:', error);
    next(); // Don't block on error
  }
}

// Extend AuthRequest type
declare module './auth.js' {
  interface AuthRequest {
    verificationStatus?: string;
    verificationRequired?: boolean;
  }
}
```

Note the one intentional behavior difference: the original used `.single()`, which errors on either zero *or more than one* matching row; a Drizzle `.limit(1)` only distinguishes zero-vs-at-least-one. Since `profiles.id` is the primary key, more than one match is structurally impossible — this difference has no practical effect.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Manual smoke test against real data**

```bash
npx tsx -e "
import { db } from './src/server/config/db.js'
import { profiles } from './src/server/db/schema.js'
import { eq } from 'drizzle-orm'

const rows = await db.select({ id: profiles.id, verificationStatus: profiles.verificationStatus, verificationRequired: profiles.verificationRequired }).from(profiles).limit(1)
console.log('Sample profile verification fields:', rows[0])
process.exit(0)
"
```
Expected: prints a real profile id with its actual `verificationStatus`/`verificationRequired` values (confirms the query runs and returns real data — the middleware itself needs a live Express request to exercise directly, which Task 6 covers end-to-end).

- [ ] **Step 4: Commit**

```bash
git add src/server/middleware/requireVerification.ts
git commit -m "feat: migrate requireVerification.ts to Drizzle"
```

---

### Task 4: Migrate `graphql/resolvers.ts`'s `updateMe` mutation to Drizzle

**Files:**
- Modify: `src/server/graphql/resolvers.ts:125-173` (the `updateMe` mutation only — every other resolver already goes through `profiles.repo.ts`, migrated in Task 1, and needs no further change)

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `profiles` from `../db/schema.js`; `rowToProfile` from `../repos/profiles.repo.js` (exported in Task 1).
- Produces: same behavior, no exported interface change.

- [ ] **Step 1: Update imports**

In `src/server/graphql/resolvers.ts`, replace:
```ts
import type { Profile } from '../repos/profiles.repo.js'
import { findById, updateLocation, updatePreferences, findNearbyUsers, findUsersInArea } from '../repos/profiles.repo.js'
import { supabase } from '../config/supabase.js'
```
with:
```ts
import type { Profile } from '../repos/profiles.repo.js'
import { findById, updateLocation, updatePreferences, findNearbyUsers, findUsersInArea, rowToProfile } from '../repos/profiles.repo.js'
import { eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'
```

Also remove the now-unused `const TABLE = 'profiles'` line (line 72) — nothing references it once the query below is migrated.

- [ ] **Step 2: Migrate the `updateMe` mutation**

Replace the query in `updateMe` (currently):
```ts
      const { data, error } = await supabase
        .from(TABLE)
        .update(allowed)
        .eq('id', ctx.user.id)
        .select('*')
        .single()
      if (error) throw error
```
with:
```ts
      const drizzleUpdate: Record<string, unknown> = {}
      if ('username' in allowed) drizzleUpdate.username = allowed.username
      if ('first_name' in allowed) drizzleUpdate.firstName = allowed.first_name
      if ('last_name' in allowed) drizzleUpdate.lastName = allowed.last_name
      if ('age' in allowed) drizzleUpdate.age = allowed.age
      if ('gender' in allowed) drizzleUpdate.gender = allowed.gender
      if ('phone_number' in allowed) drizzleUpdate.phoneNumber = allowed.phone_number
      if ('about' in allowed) drizzleUpdate.about = allowed.about
      if ('interests' in allowed) drizzleUpdate.interests = allowed.interests
      if ('needs' in allowed) drizzleUpdate.needs = allowed.needs
      if ('profile_photo_url' in allowed) drizzleUpdate.profilePhotoUrl = allowed.profile_photo_url
      if ('instagram_username' in allowed) drizzleUpdate.instagramUsername = allowed.instagram_username
      if ('invisible_mode' in allowed) drizzleUpdate.invisibleMode = allowed.invisible_mode

      const rows = await db.update(profiles).set(drizzleUpdate).where(eq(profiles.id, ctx.user.id)).returning()
      const data = rowToProfile(rows[0])
```

(`allowed` is still built exactly as before, with snake_case keys matching the `Profile` shape — this second pass maps those snake_case keys to the camelCase keys Drizzle's `.set()` expects, only for whichever fields were actually present in `allowed`. `rowToProfile` then maps the returned row back to the same snake_case shape the rest of this function already expects from `data` — e.g. `trackInterestUpdated(data as Profile, ...)` and `toUser(data as Profile)` below need no changes.)

Since `data` from `rowToProfile` is already a proper `Profile`, remove the two `as Profile` casts that follow (they're harmless but redundant now — leave them if you prefer not to touch working lines, this is optional polish, not required).

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/graphql/resolvers.ts
git commit -m "feat: migrate updateMe GraphQL mutation to Drizzle"
```

---

### Task 5: Migrate `routes/auth.routes.ts`'s direct Supabase calls to Drizzle

**Files:**
- Modify: `src/server/routes/auth.routes.ts` (4 call sites: two identical "potential matches" queries, one soft-delete update, one dead-table activity-log insert)

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `profiles` from `../db/schema.js`; `ne`, `eq`, `sql` from `drizzle-orm`.
- Produces: same behavior, no exported interface change.

- [ ] **Step 1: Update imports**

Replace:
```ts
import { supabase } from '../config/supabase.js'
```
with:
```ts
import { ne, eq, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'
```

- [ ] **Step 2: Migrate the two "potential matches" queries**

There are two identical occurrences (in `/signup` and in `/google/complete-signup`) of:
```ts
    const { data: potentialMatches } = await supabase
      .from('profiles')
      .select('id')
      .neq('id', profile.id)
      .limit(50); // Limit to prevent spam
```
(the second occurrence has the same body without the trailing comment, and a `\n` instead of `;\n`— match on the query itself, not the exact comment/semicolon formatting). Replace **both** occurrences with:
```ts
    const potentialMatches = await db.select({ id: profiles.id }).from(profiles).where(ne(profiles.id, profile.id)).limit(50) // Limit to prevent spam
```

- [ ] **Step 3: Migrate the soft-delete update**

Replace:
```ts
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        deleted_at: deletionDate.toISOString(),
        deletion_reason: reason,
        deletion_feedback: feedback || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id)

    if (updateError) {
      console.error('Error soft deleting account:', updateError)
      return res.status(500).json({ error: 'Failed to delete account' })
    }
```
with:
```ts
    try {
      await db.update(profiles).set({
        deletedAt: deletionDate.toISOString(),
        deletionReason: reason,
        deletionFeedback: feedback || null,
        updatedAt: new Date().toISOString(),
      }).where(eq(profiles.id, user.id))
    } catch (updateError) {
      console.error('Error soft deleting account:', updateError)
      return res.status(500).json({ error: 'Failed to delete account' })
    }
```

- [ ] **Step 4: Migrate the (pre-existing broken) activity-log insert**

Replace:
```ts
    // Log the deletion activity
    try {
      await supabase
        .from('user_activity')
        .insert({
          user_id: user.id,
          action: 'account_deletion_requested',
          details: { reason, feedback, scheduled_for: deletionDate.toISOString() }
        })
    } catch (activityError) {
      console.error('Error logging deletion activity:', activityError)
      // Don't fail the request if activity logging fails
    }
```
with:
```ts
    // Log the deletion activity
    // NOTE: `user_activity` is not a real table (the schema has `user_activities` and
    // `user_activity_events`, neither an exact match) - this insert has been silently
    // failing in production via the catch below even before this migration. Preserved
    // as-is rather than guessing which real table was intended; that's a product
    // decision for whoever owns this code, not something to silently change here.
    try {
      await db.execute(sql`insert into user_activity (user_id, action, details) values (${user.id}, ${'account_deletion_requested'}, ${JSON.stringify({ reason, feedback, scheduled_for: deletionDate.toISOString() })})`)
    } catch (activityError) {
      console.error('Error logging deletion activity:', activityError)
      // Don't fail the request if activity logging fails
    }
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/auth.routes.ts
git commit -m "feat: migrate auth.routes.ts direct Supabase calls to Drizzle"
```

---

### Task 6: End-to-end manual smoke test against local Postgres

**Files:** none (verification-only task)

**Interfaces:**
- Consumes: everything from Tasks 1-5, running together as the live dev server.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: server starts on the configured `PORT` without throwing at boot (confirms `db.ts`/schema wiring is sound end-to-end, not just per-file).

- [ ] **Step 2: Exercise signup + login**

In a second terminal, with the server running:
```bash
curl -s -X POST http://localhost:8080/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Test","lastName":"Migration","age":25,"gender":"other","email":"batch1-test@example.com","username":"batch1testuser","password":"testpass123","about":"Testing the Drizzle migration end to end."}'
```
Expected: `200`/`201` JSON response with an `access_token` and a `user` object whose `firstName`/`lastName` match what was sent (confirms `createProfile` → Drizzle insert → `rowToProfile` mapping is correct end-to-end, and that the write actually landed by fetching it back next).

```bash
curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"batch1-test@example.com","password":"testpass123"}'
```
Expected: `200` with a fresh `access_token` — confirms `findByEmail` + password verification round-trips correctly against the row just written.

- [ ] **Step 3: Verify the new row exists in local Postgres directly**

```bash
set -a; source .env; set +a
/opt/homebrew/opt/postgresql@17/bin/psql "$DATABASE_URL" -c "select id, email, first_name, last_name from profiles where email = 'batch1-test@example.com';"
```
Expected: one row, confirming the signup write landed in local Postgres (not Supabase — per this plan's Global Constraints, that's expected).

- [ ] **Step 4: Exercise an authenticated GraphQL query (profiles repo + resolvers + auth middleware together)**

Using the `access_token` from Step 2's login response:
```bash
curl -s -X POST http://localhost:8080/graphql \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <ACCESS_TOKEN_FROM_STEP_2>" \
  -d '{"query":"{ me { id email firstName lastName } }"}'
```
Expected: JSON with `data.me` matching the signed-up user — confirms `requireAuth` (unchanged JWT check) → GraphQL `me` resolver → `findById` (Task 1) → response shape all work together.

- [ ] **Step 5: Clean up the test row**

```bash
set -a; source .env; set +a
/opt/homebrew/opt/postgresql@17/bin/psql "$DATABASE_URL" -c "delete from profiles where email = 'batch1-test@example.com';"
```
Expected: `DELETE 1`.

- [ ] **Step 6: Stop the dev server**

Ctrl-C the process started in Step 1.

- [ ] **Step 7: Final full type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors (final confirmation across all 5 code tasks together).

No commit for this task — it's pure verification of what Tasks 1-5 already committed.

---

## Batch 1 exit criteria

All 5 code tasks committed, `npx tsc --noEmit -p .` passes, and the end-to-end smoke test in Task 6 confirms signup, login, an authenticated GraphQL query, and the soft-delete/admin-role/verification code paths all work correctly against local Postgres. At this point every file touched by this batch reads and writes exclusively through Drizzle — `supabase.from(...)` no longer appears in `profiles.repo.ts`, `middleware/auth.ts`'s `requireAdmin`, `middleware/adminAuth.ts`, `middleware/requireVerification.ts`, `graphql/resolvers.ts`, or `routes/auth.routes.ts`. The next batch (**Chat**, per the design spec's migration order) can proceed the same way.
