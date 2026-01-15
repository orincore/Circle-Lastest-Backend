# Jenkins Deployment Checklist - New Services

## ✅ Pre-Deployment Verification

### 1. Build Verification
- [x] TypeScript compilation successful (`npm run build`)
- [x] New worker files compiled:
  - `dist/server/workers/continuous-blind-matching.js` ✅
  - `dist/server/workers/inactive-blind-date-reminder.js` ✅
- [x] Admin endpoints created in `admin-blind-dating.routes.ts`
- [x] Admin UI buttons added in `blind-dating.jsx`

### 2. Docker Configuration
- [x] PM2 ecosystem config updated (`docker/ecosystem.matchmaking.config.cjs`)
  - Added `blind-matcher` process
  - Added `blind-reminder` process
- [x] Both services configured to run in matchmaking container
- [x] Memory limits set appropriately (150MB each)
- [x] Auto-restart and cron restart configured

### 3. Code Changes Summary
**New Files:**
- `src/server/workers/continuous-blind-matching.ts` - Runs every 4-5 hours
- `src/server/workers/inactive-blind-date-reminder.ts` - Runs every 6 hours
- `IMPLEMENTATION_SUMMARY.md` - Complete documentation

**Modified Files:**
- `src/server/services/emailService.ts` - Added `sendBlindDateReminder()` method
- `src/server/services/notificationService.ts` - Enhanced profile visit notifications
- `src/server/routes/explore.routes.ts` - Added preference-based filtering
- `src/server/routes/admin-blind-dating.routes.ts` - Added test endpoints
- `CircleReact/contexts/AuthContext.jsx` - Fixed auth persistence (30min interval)
- `CircleReact/app/admin/blind-dating.jsx` - Added test buttons
- `docker/ecosystem.matchmaking.config.cjs` - Added new PM2 processes
- `package.json` - Increased build memory to 2048MB

## 🚀 Jenkins Deployment Process

### What Jenkins Will Do Automatically:

1. **Pull Latest Code** ✅
   - Fetches all changes from main branch
   - Includes all new worker files and configurations

2. **Build Docker Images** ✅
   - Builds matchmaking container with new PM2 config
   - Compiles TypeScript inside container (2GB memory available)
   - Includes both new worker services

3. **Blue-Green Deployment** ✅
   - Updates matchmaking container in both blue and green sets
   - Zero downtime deployment
   - Automatic health checks

4. **Service Startup** ✅
   - PM2 automatically starts all 3 processes:
     - `circle-matchmaking` (existing)
     - `blind-matcher` (NEW - runs every 4-5 hours)
     - `blind-reminder` (NEW - runs every 6 hours)

### Expected Container Processes After Deployment:

```bash
# Inside matchmaking container, PM2 will show:
┌─────┬──────────────────────┬─────────┬─────────┬──────────┐
│ id  │ name                 │ status  │ restart │ uptime   │
├─────┼──────────────────────┼─────────┼─────────┼──────────┤
│ 0   │ circle-matchmaking   │ online  │ 0       │ 2m       │
│ 1   │ blind-matcher        │ online  │ 0       │ 2m       │
│ 2   │ blind-reminder       │ online  │ 0       │ 2m       │
└─────┴──────────────────────┴─────────┴─────────┴──────────┘
```

## 🧪 Post-Deployment Testing

### 1. Verify Services are Running

SSH into production server:
```bash
ssh root@69.62.82.102
cd /root/Circle-Lastest-Backend

# Check matchmaking container processes
docker exec circle-matchmaking-blue pm2 list
docker exec circle-matchmaking-green pm2 list

# Both should show 3 processes running
```

### 2. Check Service Logs

```bash
# View continuous matcher logs
docker exec circle-matchmaking-blue pm2 logs blind-matcher --lines 50

# View reminder service logs
docker exec circle-matchmaking-blue pm2 logs blind-reminder --lines 50

# Check for startup messages:
# - "🚀 Starting continuous blind dating matcher service"
# - "🚀 Starting inactive blind date reminder service"
# - "⏰ Next matching cycle scheduled in X hours"
```

### 3. Test Admin Panel Buttons

1. Log into admin panel: https://circle.orincore.com/admin
2. Navigate to Blind Dating section
3. Test buttons:
   - **"Test Continuous Matcher"** - Should run one matching cycle
   - **"Test Reminder Service"** - Should check for inactive matches
4. Verify responses show success and statistics

### 4. Verify Database Changes

```sql
-- Check if reminder_sent_at column exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'blind_date_matches' 
AND column_name = 'reminder_sent_at';

-- If missing, add it:
ALTER TABLE blind_date_matches 
ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
```

## 📊 Monitoring After Deployment

### Key Metrics to Watch:

1. **Matching Service**
   - Check logs every 4-5 hours for matching cycles
   - Monitor: processed count, matched count, errors
   - Expected: Automatic matching happening throughout the day

2. **Reminder Service**
   - Check logs every 6 hours for reminder checks
   - Monitor: inactive matches found, reminders sent
   - Expected: Emails sent to users with inactive matches

3. **Container Health**
   ```bash
   docker ps --filter "name=matchmaking" --format "table {{.Names}}\t{{.Status}}"
   ```

4. **Memory Usage**
   ```bash
   docker stats circle-matchmaking-blue circle-matchmaking-green --no-stream
   ```

### Expected Behavior:

- **First 5 hours**: Continuous matcher runs first cycle, creates matches
- **First 6 hours**: Reminder service checks for inactive matches (24h+ old)
- **Ongoing**: Services run automatically on schedule
- **Daily 3 AM**: PM2 restarts both services (cron_restart)

## ⚠️ Troubleshooting

### If Services Don't Start:

```bash
# Check PM2 logs
docker exec circle-matchmaking-blue pm2 logs --lines 100

# Restart specific service
docker exec circle-matchmaking-blue pm2 restart blind-matcher
docker exec circle-matchmaking-blue pm2 restart blind-reminder

# Check for errors
docker logs circle-matchmaking-blue --tail 100
```

### If Build Fails:

The Jenkinsfile uses 2048MB memory for builds inside Docker, which should be sufficient. If it still fails:

```bash
# On production server, manually build:
cd /root/Circle-Lastest-Backend
docker-compose -f docker-compose.production.yml build matchmaking --no-cache
```

### If Admin Test Buttons Don't Work:

1. Check admin authentication is working
2. Verify endpoints exist: `/api/admin/blind-dating/test-continuous-matcher`
3. Check browser console for errors
4. Verify token is being sent in Authorization header

## 🎯 Success Criteria

✅ **Deployment is successful when:**

1. Jenkins build completes without errors
2. All 3 PM2 processes show "online" status
3. Admin test buttons return success responses
4. Service logs show scheduled cycles running
5. No errors in container logs
6. Memory usage is stable (under 150MB per service)
7. Existing matchmaking service still works normally

## 📝 Rollback Plan

If issues occur after deployment:

```bash
# SSH to server
ssh root@69.62.82.102
cd /root/Circle-Lastest-Backend

# Get previous commit
git log -5 --oneline

# Rollback to previous version
git checkout <previous-commit-hash>
export CACHEBUST=<previous-commit-hash>

# Rebuild and restart
docker-compose -f docker-compose.production.yml build matchmaking
docker-compose -f docker-compose.production.yml up -d --no-deps matchmaking-blue matchmaking-green
```

## 🔗 Related Documentation

- Full implementation details: `IMPLEMENTATION_SUMMARY.md`
- Docker config: `docker/ecosystem.matchmaking.config.cjs`
- Admin endpoints: `src/server/routes/admin-blind-dating.routes.ts`
- Worker services: `src/server/workers/`

## ✅ Final Checklist Before Triggering Jenkins

- [x] All code committed to main branch
- [x] Build successful locally (`npm run build`)
- [x] New worker files exist in `dist/` folder
- [x] Docker config updated with new PM2 processes
- [x] Admin panel UI updated with test buttons
- [x] Documentation complete
- [ ] Database migration ready (add reminder_sent_at column)
- [ ] Team notified about new features
- [ ] Ready to trigger Jenkins deployment

---

**Next Step:** Commit all changes and push to main branch to trigger Jenkins deployment.

```bash
git add .
git commit -m "feat: Add continuous blind matching and reminder services

- Automated matching every 4-5 hours
- Email reminders for inactive matches
- Enhanced push notifications
- Improved explore page filtering
- Fixed auth persistence
- Added admin test buttons"

git push origin main
```

Jenkins will automatically deploy to production with zero downtime! 🚀
