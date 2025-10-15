# Referral System - Admin Panel & Notifications Implementation

## Overview
This document describes the implementation of the referral system's admin panel features and user notification system.

## Features Implemented

### 1. Admin Panel - Referral Management

#### **Admin Routes** (`/api/admin/referrals`)

All admin routes require authentication and admin role.

##### Statistics & Overview
- **GET `/api/admin/referrals/stats`**
  - Returns overview statistics for the referral system
  - Includes: total referrals by status, earnings breakdown, recent referrals, pending payments

##### Transaction Management
- **GET `/api/admin/referrals/transactions`**
  - Get all referral transactions with filters
  - Query params: `status`, `page`, `limit`, `search`, `startDate`, `endDate`
  - Returns paginated list with referrer and referred user details

- **GET `/api/admin/referrals/pending`**
  - Get all pending referrals awaiting verification
  - Sorted by creation date (oldest first)
  - Includes full user details for both referrer and referred user

- **POST `/api/admin/referrals/:transactionId/verify`**
  - Approve or reject a referral transaction
  - Body: `{ status: 'approved' | 'rejected', rejectionReason?: string }`
  - Sends notification to user upon verification
  - Only pending referrals can be verified

- **POST `/api/admin/referrals/:transactionId/mark-paid`**
  - Mark an approved referral as paid
  - Body: `{ paymentReference?: string }`
  - Sends payment confirmation notification to user
  - Only approved referrals can be marked as paid

##### Payment Request Management
- **GET `/api/admin/referrals/payment-requests`**
  - Get all payment requests from users
  - Query params: `status`, `page`, `limit`
  - Returns paginated list with user details

- **POST `/api/admin/referrals/payment-requests/:requestId/process`**
  - Process a payment request (complete or fail)
  - Body: `{ status: 'completed' | 'failed', paymentReference?: string, notes?: string }`

##### User Details & Analytics
- **GET `/api/admin/referrals/user/:userId`**
  - Get complete referral details for a specific user
  - Returns: referral info, all transactions, payment requests

- **GET `/api/admin/referrals/analytics`**
  - Get referral analytics with date filtering
  - Query params: `startDate`, `endDate`
  - Returns daily statistics and summary

### 2. User Notifications

#### **New Notification Types**

Added to `NotificationService`:

1. **`referral_signup`** - When someone signs up using user's referral code
   - Title: "🎉 New Referral!"
   - Message: "{Name} just signed up using your referral code! Referral #{number}"

2. **`referral_approved`** - When admin approves a referral
   - Title: "✅ Referral Approved!"
   - Message: "Your referral #{number} has been approved! ₹{amount} added to your pending earnings."

3. **`referral_rejected`** - When admin rejects a referral
   - Title: "❌ Referral Rejected"
   - Message: "Your referral #{number} was rejected. Reason: {reason}"

4. **`referral_paid`** - When payment is completed
   - Title: "💰 Payment Completed!"
   - Message: "Payment of ₹{amount} for referral #{number} has been completed! Reference: {ref}"

#### **Notification Methods**

```typescript
// Notify when someone signs up with referral code
await NotificationService.notifyReferralSignup(
  referrerId: string,
  referredUserName: string,
  referralNumber: string
);

// Notify when referral is approved
await NotificationService.notifyReferralApproved(
  userId: string,
  referralNumber: string,
  amount: number
);

// Notify when referral is rejected
await NotificationService.notifyReferralRejected(
  userId: string,
  referralNumber: string,
  reason: string
);

// Notify when payment is completed
await NotificationService.notifyReferralPaid(
  userId: string,
  referralNumber: string,
  amount: number,
  paymentReference?: string
);
```

### 3. Live Notifications

All referral notifications are sent in real-time via WebSocket using the existing `emitToUser` function:
- Users receive instant notifications when events occur
- Notifications appear in the notification panel
- Unread count is updated automatically

### 4. Updated Referral Routes

Updated existing routes in `/api/referrals`:

- **`applyReferralCode()`** - Now sends notification to referrer when someone signs up
- **`POST /admin/verify/:transactionId`** - Now sends approval/rejection notification
- **`POST /admin/mark-paid/:transactionId`** - Now sends payment confirmation notification

## Database Schema

The system uses these tables (already created):

1. **`user_referrals`** - User referral codes and earnings
2. **`referral_transactions`** - Individual referral transactions with status tracking
3. **`referral_payment_requests`** - UPI payment requests from users
4. **`referral_code_attempts`** - Analytics for code usage attempts
5. **`notifications`** - Stores all notifications including referral notifications

## Workflow

### Referral Lifecycle

1. **User Signs Up with Referral Code**
   - System validates code
   - Creates pending transaction
   - Sends notification to referrer: "🎉 New Referral!"

2. **Admin Reviews Pending Referrals**
   - Access via `/api/admin/referrals/pending`
   - View all pending referrals with user details
   - Verify authenticity

3. **Admin Approves/Rejects**
   - POST to `/api/admin/referrals/:id/verify`
   - System updates transaction status
   - Sends notification to user:
     - If approved: "✅ Referral Approved! ₹10 added"
     - If rejected: "❌ Referral Rejected. Reason: {reason}"

4. **Admin Marks as Paid**
   - POST to `/api/admin/referrals/:id/mark-paid`
   - System updates earnings (pending → paid)
   - Sends notification: "💰 Payment Completed!"

### Payment Request Workflow

1. **User Requests Payment**
   - POST to `/api/referrals/request-payment`
   - Minimum ₹100 required

2. **Admin Processes Request**
   - View via `/api/admin/referrals/payment-requests`
   - Process via POST to `/api/admin/referrals/payment-requests/:id/process`
   - Mark as completed or failed

## API Examples

### Admin: Get Pending Referrals
```bash
GET /api/admin/referrals/pending?limit=50&offset=0
Authorization: Bearer {admin_token}
```

### Admin: Approve Referral
```bash
POST /api/admin/referrals/{transaction_id}/verify
Authorization: Bearer {admin_token}
Content-Type: application/json

{
  "status": "approved"
}
```

### Admin: Reject Referral
```bash
POST /api/admin/referrals/{transaction_id}/verify
Authorization: Bearer {admin_token}
Content-Type: application/json

{
  "status": "rejected",
  "rejectionReason": "Duplicate account detected"
}
```

### Admin: Mark as Paid
```bash
POST /api/admin/referrals/{transaction_id}/mark-paid
Authorization: Bearer {admin_token}
Content-Type: application/json

{
  "paymentReference": "UPI123456789"
}
```

### User: Get Notifications
```bash
GET /api/notifications?limit=50
Authorization: Bearer {user_token}
```

## Frontend Integration

### Admin Panel Components Needed

1. **Referral Dashboard**
   - Display stats from `/api/admin/referrals/stats`
   - Show pending count, total earnings, etc.

2. **Pending Referrals Table**
   - Fetch from `/api/admin/referrals/pending`
   - Show referrer, referred user, date, status
   - Action buttons: Approve, Reject

3. **All Transactions Table**
   - Fetch from `/api/admin/referrals/transactions`
   - Filter by status, date range
   - Pagination support

4. **Payment Requests Table**
   - Fetch from `/api/admin/referrals/payment-requests`
   - Show user, amount, UPI ID, status
   - Action buttons: Complete, Fail

### User Notification Panel

The existing notification panel will automatically show referral notifications:
- Filter by type: `referral_signup`, `referral_approved`, `referral_rejected`, `referral_paid`
- Display with appropriate icons and colors
- Mark as read functionality already implemented

## Security Considerations

1. **Admin Authentication**: All admin routes require `requireAuth` and `requireAdmin` middleware
2. **Input Validation**: All inputs are validated before processing
3. **SQL Injection Prevention**: Using Supabase parameterized queries
4. **Rate Limiting**: Global rate limiting applied to all routes
5. **Audit Trail**: All admin actions should be logged (can be enhanced)

## Testing Checklist

- [ ] Admin can view pending referrals
- [ ] Admin can approve referral → user receives notification
- [ ] Admin can reject referral → user receives notification with reason
- [ ] Admin can mark referral as paid → user receives payment notification
- [ ] User receives notification when someone signs up with their code
- [ ] Notifications appear in real-time (WebSocket)
- [ ] Notifications appear in notification panel
- [ ] Payment requests are visible to admin
- [ ] Admin can process payment requests
- [ ] Analytics endpoint returns correct data

## Future Enhancements

1. **Email Notifications**: Send email in addition to in-app notifications
2. **Push Notifications**: Mobile push notifications for referral events
3. **Bulk Actions**: Approve/reject multiple referrals at once
4. **Advanced Analytics**: Charts, graphs, conversion rates
5. **Automated Verification**: AI-based fraud detection
6. **Referral Tiers**: Different reward amounts based on user activity
7. **Referral Campaigns**: Time-limited bonus campaigns

## Files Modified/Created

### Created
- `/Backend/src/server/routes/admin-referrals.routes.ts` - Admin referral management routes
- `/Backend/docs/REFERRAL_ADMIN_NOTIFICATIONS.md` - This documentation

### Modified
- `/Backend/src/server/services/notificationService.ts` - Added referral notification types and methods
- `/Backend/src/server/routes/referral.routes.ts` - Added notification triggers
- `/Backend/src/server/app.ts` - Registered new routes

## Support

For issues or questions, contact the development team or refer to:
- Database schema: `/Backend/database/referral_system.sql`
- Referral guide: `/REFERRAL_SYSTEM_GUIDE.md`
