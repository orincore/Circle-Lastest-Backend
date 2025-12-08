# Prompt-Based Giver/Receiver Matching System

## Overview

A universal connection feature that matches users seeking help (Receivers) with users who can provide help (Givers) using vector-based semantic matching and real-time Socket.IO communication.

## Features

- **Role-Based Matching**: Users can be Givers (helpers) or Receivers (help seekers)
- **Vector Similarity Search**: Uses pgvector for semantic matching between prompts and giver profiles
- **Real-Time Notifications**: Socket.IO events for instant request delivery
- **Masked Identity**: Uses existing Blind Date system for privacy (30-message reveal)
- **1-Hour Retry Loop**: Automatically retries matching if initial attempts fail
- **Background Processing**: Handles expired requests and retry logic

## Architecture

### Database Schema

Location: `/database/prompt_matching_system.sql`

**Tables:**
- `giver_profiles` - Stores giver capabilities with vector embeddings
- `help_requests` - Tracks receiver requests with prompt embeddings
- `giver_request_attempts` - Logs individual matching attempts
- `help_session_feedback` - Stores ratings after help sessions

**Key RPC Functions:**
- `find_best_giver_match()` - Vector similarity search
- `create_help_request()` - Creates new help request
- `record_giver_response()` - Handles accept/decline
- `get_active_help_requests()` - For retry logic
- `expire_old_help_requests()` - Cleanup function

### Backend Implementation

**Service Layer:**
- `/src/server/services/prompt-matching.service.ts`
  - `createHelpRequest()` - Creates request and finds first giver
  - `findAndNotifyGiver()` - Matches and notifies giver via socket
  - `handleGiverResponse()` - Processes accept/decline
  - `processActiveHelpRequests()` - Background retry logic

**Routes:**
- `/src/server/routes/prompt-matching.routes.ts`
  - `POST /api/match/request` - Create help request
  - `GET /api/match/status/:requestId` - Get request status
  - `POST /api/match/cancel/:requestId` - Cancel request
  - `POST /api/match/giver/setup` - Setup giver profile
  - `POST /api/match/giver/toggle` - Toggle availability
  - `GET /api/match/giver/profile` - Get giver profile
  - `POST /api/match/giver/respond` - Respond to request

**Socket Handlers:**
- `/src/server/handlers/promptMatchingHandler.ts`
  - `giver_response` - Giver accepts/declines
  - `cancel_help_request` - Receiver cancels
  - `toggle_giver_availability` - Toggle availability
  - `get_giver_profile` - Get profile data
  - `get_active_help_request` - Get active request

**Socket Events Emitted:**
- `incoming_help_request` - To giver when matched
- `help_request_accepted` - To receiver when giver accepts
- `help_request_declined` - To receiver when giver declines
- `help_request_chat_ready` - To giver when chat is created

### Frontend Implementation

**Screens:**
- `/app/secure/help-request.jsx` - Receiver prompt input
- `/app/secure/help-searching.jsx` - Searching animation
- `/app/secure/chat-conversation.jsx` - Existing masked chat (reused)

**Components:**
- `/components/HelpRoleToggle.jsx` - Giver/Receiver/Off toggle
- `/components/GiverRequestModal.jsx` - Incoming request modal
- `/components/PromptMatchingWrapper.jsx` - Integration wrapper

**API Client:**
- `/src/api/promptMatching.js` - API service methods

**Hooks:**
- `/src/hooks/usePromptMatching.js` - Socket event management

## User Flows

### Receiver Flow

1. User selects "Receiver" on home toggle
2. Navigates to help request screen
3. Enters prompt describing their need
4. System generates embedding and searches for matching giver
5. If found, shows "Searching..." animation
6. When giver accepts, navigates to masked chat
7. If giver declines, automatically finds next giver
8. Request expires after 1 hour if no match

### Giver Flow

1. User selects "Giver" on home toggle
2. System marks them as available
3. When matched, receives modal with:
   - Masked receiver profile
   - Help request prompt
   - Similarity score
4. Can accept or decline
5. If accepted, navigates to masked chat
6. If declined, system finds next giver for receiver

### Chat Flow (Reuses Blind Date System)

1. Chat created with masked identities
2. First 30 messages hide real identities
3. After 30 messages each, reveal option appears
4. Both must approve to reveal identities
5. Existing message filtering applies

## Integration Steps

### 1. Database Setup

```sql
-- Run the SQL file in Supabase SQL Editor
-- File: /database/prompt_matching_system.sql
```

### 2. Backend Setup

Already integrated in:
- `src/server/app.ts` - Route registered
- `src/server/sockets/optimized-socket.ts` - Handler registered

### 3. Frontend Integration

Add to home screen (e.g., `/app/secure/(tabs)/match.jsx`):

```jsx
import PromptMatchingWrapper from '@/components/PromptMatchingWrapper';

// Inside your component
<PromptMatchingWrapper />
```

### 4. Environment Variables

No additional environment variables needed. Uses existing:
- `TOGETHER_AI_API_KEY` - For embeddings (placeholder implementation)
- Socket.IO configuration
- Supabase configuration

## Vector Embeddings

**Current Implementation:**
- Placeholder: Random 1536-dimensional vectors
- Location: `PromptMatchingService.generateEmbedding()`

**Production Recommendation:**
Replace with actual embedding model:
```typescript
// Use OpenAI, Cohere, or similar
const response = await openai.embeddings.create({
  model: "text-embedding-ada-002",
  input: text,
});
return response.data[0].embedding;
```

## Background Jobs

**Recommended Cron Jobs:**

1. **Retry Active Requests** (Every 5 minutes)
```typescript
import { PromptMatchingService } from './services/prompt-matching.service';

setInterval(async () => {
  await PromptMatchingService.processActiveHelpRequests();
}, 5 * 60 * 1000);
```

2. **Expire Old Requests** (Every 10 minutes)
```typescript
setInterval(async () => {
  await PromptMatchingService.expireOldRequests();
}, 10 * 60 * 1000);
```

## Security & Privacy

- **RLS Policies**: Enabled on all tables
- **Masked Identities**: Uses blind_date_matches table
- **Block Check**: Respects existing block relationships
- **Input Validation**: 500 character limit on prompts
- **Rate Limiting**: Existing rate limits apply

## Testing

### Test Giver Profile Creation
```bash
curl -X POST http://localhost:3000/api/match/giver/setup \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"skills": ["coding", "career"], "categories": ["tech", "professional"]}'
```

### Test Help Request
```bash
curl -X POST http://localhost:3000/api/match/request \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "I need help with my resume", "role": "receiver"}'
```

### Test Socket Events
Use the frontend or Socket.IO client to test real-time events.

## Monitoring

**Key Metrics to Track:**
- Help requests created per day
- Average match time
- Giver acceptance rate
- Session completion rate
- Average ratings

**Database Queries:**
```sql
-- Active requests
SELECT COUNT(*) FROM help_requests WHERE status = 'searching';

-- Top givers
SELECT * FROM giver_leaderboard LIMIT 10;

-- Match success rate
SELECT 
  COUNT(*) FILTER (WHERE status = 'matched') * 100.0 / COUNT(*) as success_rate
FROM help_requests
WHERE created_at > NOW() - INTERVAL '7 days';
```

## Future Enhancements

1. **Category Filtering**: Allow givers to specify help categories
2. **Scheduling**: Let receivers schedule help for later
3. **Group Help**: Multiple givers for one receiver
4. **Video/Voice**: Integrate with existing voice call system
5. **Reputation System**: Badges and levels for top givers
6. **AI Suggestions**: Suggest prompt improvements
7. **Analytics Dashboard**: Admin view of matching metrics

## Troubleshooting

### No Givers Found
- Check if any users have giver profiles: `SELECT COUNT(*) FROM giver_profiles WHERE is_available = TRUE`
- Verify embeddings are generated correctly
- Check block relationships

### Socket Events Not Received
- Verify socket connection in browser console
- Check user is in their socket room
- Verify handler is registered in `optimized-socket.ts`

### Slow Matching
- Check vector index: `EXPLAIN ANALYZE` on similarity queries
- Increase `lists` parameter in ivfflat index
- Consider caching giver profiles

## API Reference

See `/src/server/routes/prompt-matching.routes.ts` for complete API documentation.

## Support

For issues or questions:
1. Check logs: `logger.info/error` in service files
2. Review socket events in browser console
3. Check Supabase logs for RPC errors
4. Verify database schema is applied correctly
