# 🔧 Mute Notifications Debug Guide

## 🚨 **Current Issue:**
Toast notifications still appear after muting a chat.

## 🔍 **Debugging Steps:**

### **1. Check Database Setup**
First, verify the `chat_mute_settings` table exists:

```sql
-- Run in Supabase SQL Editor:
SELECT table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'chat_mute_settings' 
ORDER BY ordinal_position;
```

**Expected Result:** Should show columns: `id`, `user_id`, `chat_id`, `is_muted`, `muted_until`, `created_at`, `updated_at`

**If table doesn't exist:** Run the `chat_mute_notifications_schema.sql` file.

### **2. Test Mute Setting API**
Check if the mute setting is being saved correctly:

**Backend Logs to Watch:**
- `Setting mute status: { userId, chatId, isMuted }`
- `Mute setting saved: { setting object }`
- `Getting mute setting for: { userId, chatId }`
- `Mute setting result: { userId, chatId, muted, setting }`

### **3. Test Notification Logic**
Check if notifications are being blocked:

**Frontend Logs to Watch:**
- `Checking notification for message: { chatId, senderName }`
- `Checking mute status for chat: [chatId]`
- `Mute status result: { chatId, isMuted }`
- `Chat is muted, skipping notification` ← This should appear for muted chats
- `Showing notification for unmuted chat` ← This should NOT appear for muted chats

### **4. Common Issues & Solutions:**

#### **Issue A: Database Table Missing**
**Symptom:** Error logs about table not existing
**Solution:** Run the SQL schema file in Supabase

#### **Issue B: RLS Policies Blocking Access**
**Symptom:** Empty results even when data exists
**Solution:** Check RLS policies:
```sql
SELECT * FROM pg_policies WHERE tablename = 'chat_mute_settings';
```

#### **Issue C: Auth Token Not Available**
**Symptom:** `No auth token available for mute check`
**Solution:** Verify socket service is initialized with token

#### **Issue D: API Endpoint Not Working**
**Symptom:** 404 or 500 errors when calling mute API
**Solution:** Check backend server is running and routes are registered

## 🧪 **Manual Testing Steps:**

### **Step 1: Mute a Chat**
1. Open chat screen
2. Tap 3-dot menu (should work on iOS now)
3. Tap "Mute Notifications"
4. Verify success message appears

### **Step 2: Send Test Message**
1. From another device/user, send a message to the muted chat
2. Check console logs for mute status check
3. Verify NO toast notification appears

### **Step 3: Unmute and Test**
1. Tap 3-dot menu again
2. Tap "Unmute Notifications" 
3. Send another test message
4. Verify toast notification DOES appear

## 📊 **Debug Console Commands:**

### **Check Current Mute Status (Frontend):**
```javascript
// In browser console or React Native debugger:
const { chatApi } = require('./src/api/chat');
const token = 'your-auth-token';
const chatId = 'your-chat-id';
chatApi.getMuteStatus(chatId, token).then(console.log);
```

### **Check Database Directly (Supabase):**
```sql
-- Replace with actual user_id and chat_id
SELECT * FROM chat_mute_settings 
WHERE user_id = 'your-user-id' AND chat_id = 'your-chat-id';
```

## 🔧 **Current Debug Features Added:**

### **Backend Debugging:**
- ✅ Console logs in API endpoints
- ✅ Database operation logging
- ✅ Error handling for missing table
- ✅ RLS policy checks

### **Frontend Debugging:**
- ✅ Notification decision logging
- ✅ Mute status check logging
- ✅ Auth token availability checks
- ✅ Early returns with explanations

## 🎯 **Expected Log Flow for Muted Chat:**

```
1. Backend: "Setting mute status: { userId: 'abc', chatId: 'xyz', isMuted: true }"
2. Backend: "Mute setting saved: { ... }"
3. [New message arrives]
4. Frontend: "Checking notification for message: { chatId: 'xyz', senderName: 'John' }"
5. Frontend: "Checking mute status for chat: xyz"
6. Backend: "Getting mute setting for: { userId: 'abc', chatId: 'xyz' }"
7. Backend: "Retrieved mute setting: { is_muted: true, ... }"
8. Backend: "Final mute status: true"
9. Frontend: "Mute status result: { chatId: 'xyz', isMuted: true }"
10. Frontend: "Chat is muted, skipping notification" ← SUCCESS!
```

## 🚀 **Next Steps:**

1. **Run the database schema** if not already done
2. **Restart backend server** to get new debug logs
3. **Test mute/unmute** and watch console logs
4. **Send test messages** and verify notification behavior
5. **Check logs** to identify where the flow breaks

If notifications still appear after following this guide, the console logs will show exactly where the issue is occurring.
