# Backend Fixes Summary - Database Foreign Key & Schema Issues

## Issues Fixed

### 1. ✅ Chat Schema Error - `user1_id` Column Not Found

**Error:**
```
column chats.user1_id does not exist
```

**Root Cause:** Code was querying `chats` table with `user1_id` and `user2_id` columns that don't exist.

**Correct Schema:**
- `chats` table: `id`, `created_at`, `last_message_at`
- `chat_members` table (junction): `chat_id`, `user_id`, `joined_at`

**Fix Applied:** Updated `Backend/src/server/routes/friends.routes.ts` to use `chat_members` junction table instead of non-existent columns.

**Changed Code:**
```typescript
// Before (❌ Incorrect)
const { data: chats } = await supabase
  .from('chats')
  .select('id, user1_id, user2_id')  // These columns don't exist!
  .or(`and(user1_id.eq.${userId},user2_id.in.(${friendUserIds.join(',')}))...`)

// After (✅ Correct)
// Get all chats where user is a member
const { data: userChatMembers } = await supabase
  .from('chat_members')
  .select('chat_id')
  .eq('user_id', userId)

// Get all members of those chats
const { data: allChatMembers } = await supabase
  .from('chat_members')
  .select('chat_id, user_id')
  .in('chat_id', userChatIds)

// Map friendId -> chatId for 1:1 chats
```

---

### 2. ✅ Foreign Key Constraint Violations

**Errors:**
```
insert or update on table "user_profile_visits" violates foreign key constraint
Key (visited_user_id)=(8ccd6396-3d6f-475d-abac-a3a0a0aea279) is not present in table "profiles"

insert or update on table "notifications" violates foreign key constraint  
Key (recipient_id)=(8ccd6396-3d6f-475d-abac-a3a0a0aea279) is not present in table "profiles"
```

**Root Cause:** Code was trying to create records referencing user IDs that don't exist in the `profiles` table.

**Fixes Applied:**

#### A. Profile Visit Validation (`circle-points.service.ts`)

Added validation before creating profile visit records:

```typescript
static async recordProfileVisit(visitorId: string, visitedUserId: string): Promise<void> {
  try {
    // Don't record self-visits
    if (visitorId === visitedUserId) return
    
    // ✅ NEW: Validate that both users exist
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .in('id', [visitorId, visitedUserId])
    
    if (profileError) {
      console.error('Error validating user profiles:', profileError)
      return
    }
    
    // Check if both users exist
    if (!profiles || profiles.length !== 2) {
      console.warn(`Profile visit skipped: User(s) not found. Visitor: ${visitorId}, Visited: ${visitedUserId}`)
      return  // Gracefully skip instead of crashing
    }
    
    // Continue with profile visit creation...
  }
}
```

#### B. Notification Validation (`notificationService.ts`)

Added validation before creating notifications:

```typescript
static async createNotification(notificationData: NotificationData): Promise<any> {
  try {
    // ✅ NEW: Validate recipient exists
    const { data: recipientProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', notificationData.recipient_id)
      .maybeSingle();
    
    if (!recipientProfile) {
      console.warn(`Notification skipped: Recipient not found. ID: ${notificationData.recipient_id}`)
      return null  // Gracefully skip
    }

    // ✅ NEW: Validate sender if provided
    if (notificationData.sender_id) {
      const { data: senderProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', notificationData.sender_id)
        .maybeSingle();
      
      if (!senderProfile) {
        console.warn(`Notification skipped: Sender not found. ID: ${notificationData.sender_id}`)
        return null  // Gracefully skip
      }
    }
    
    // Continue with notification creation...
  }
}
```

---

### 3. ✅ User Profile Not Found Errors

**Error:**
```
Error fetching user profile: {
  code: 'PGRST116',
  message: 'Cannot coerce the result to a single JSON object',
  details: 'The result contains 0 rows'
}
```

**Status:** These are **expected errors** when querying non-existent users. The code already handles them properly:
- Returns 404 status
- Returns empty arrays
- Logs for debugging

**No fix needed** - this is normal behavior when a user doesn't exist.

---

## Why These Errors Occurred

### Possible Causes:

1. **Deleted Users:** User accounts were deleted but references remain in:
   - Socket connections
   - Cached data
   - Pending operations

2. **Race Conditions:** User deleted while operations were in progress

3. **Test Data:** Development/test user IDs that don't exist in production

4. **Data Migration:** Old data referencing users that no longer exist

---

## Files Modified

1. ✅ `Backend/src/server/routes/friends.routes.ts`
   - Fixed chat fetching to use `chat_members` junction table

2. ✅ `Backend/src/server/services/circle-points.service.ts`
   - Added user validation before profile visit creation

3. ✅ `Backend/src/server/services/notificationService.ts`
   - Added user validation before notification creation

---

## Testing Checklist

After restarting the backend, verify:

- [ ] Friends list loads without errors
- [ ] Chat IDs are correctly associated with friends
- [ ] Can send messages to friends
- [ ] Profile visits work for existing users
- [ ] Notifications work for existing users
- [ ] No foreign key constraint errors in logs
- [ ] Graceful handling of non-existent user IDs

---

## Restart Backend

```bash
cd Backend
pm2 restart circle-backend
# or
npm run dev
```

---

## Prevention Strategies

### 1. Always Validate User Existence

Before any operation involving user IDs:
```typescript
const { data: user } = await supabase
  .from('profiles')
  .select('id')
  .eq('id', userId)
  .maybeSingle()

if (!user) {
  console.warn(`Operation skipped: User ${userId} not found`)
  return
}
```

### 2. Use Soft Deletes

Instead of hard deleting users, mark them as deleted:
```sql
ALTER TABLE profiles ADD COLUMN deleted_at TIMESTAMP;
```

### 3. Cascade Deletes

Set up proper cascade rules in database:
```sql
ALTER TABLE user_profile_visits
  DROP CONSTRAINT user_profile_visits_visited_user_id_fkey,
  ADD CONSTRAINT user_profile_visits_visited_user_id_fkey
    FOREIGN KEY (visited_user_id)
    REFERENCES profiles(id)
    ON DELETE CASCADE;
```

### 4. Clean Up Orphaned Data

Periodically clean up records referencing deleted users:
```sql
-- Find orphaned profile visits
SELECT * FROM user_profile_visits
WHERE visitor_id NOT IN (SELECT id FROM profiles)
   OR visited_user_id NOT IN (SELECT id FROM profiles);

-- Delete orphaned records
DELETE FROM user_profile_visits
WHERE visitor_id NOT IN (SELECT id FROM profiles)
   OR visited_user_id NOT IN (SELECT id FROM profiles);
```

---

## Summary

All critical errors have been fixed:
- ✅ Chat schema corrected to use `chat_members` junction table
- ✅ Profile visit validation added
- ✅ Notification validation added
- ✅ Graceful error handling implemented

The backend will now skip operations for non-existent users instead of crashing with foreign key errors.
