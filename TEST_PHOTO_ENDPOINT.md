# Test Photo Gallery Endpoint

## ✅ Setup Verified

**Route Import:** ✅ Line 55 in `src/server/app.ts`
```typescript
import userPhotosRouter from './routes/user-photos.routes.js'
```

**Route Registration:** ✅ Line 235 in `src/server/app.ts`
```typescript
app.use('/api/users', userPhotosRouter)
```

**File Compiled:** ✅ `dist/server/routes/user-photos.routes.js` exists

## 🚀 Next Steps

### Step 1: Restart Backend Server

```bash
cd /Users/orincore/Documents/circle\ prj/Backend

# If using PM2
pm2 restart circle-backend

# OR if running manually
npm run dev
```

### Step 2: Verify Server is Running

```bash
# Check PM2 status
pm2 status

# Check if port 3000 is listening
lsof -i :3000

# Test health endpoint
curl http://localhost:3000/health
```

### Step 3: Test Photo Endpoint Locally

```bash
# Test GET endpoint (should return 401 without token)
curl http://localhost:3000/api/users/photos

# Expected response: 401 Unauthorized or authentication error
# If you get 404, the route isn't loaded
```

### Step 4: Test with Real Token

```bash
# Replace YOUR_TOKEN with actual JWT token
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/users/photos

# Expected response: {"photos": []}
```

### Step 5: Test from App

After restarting backend, try uploading a photo in the app.

**Expected Console Output:**
```
📸 Fetching photos from: https://api.orincore.com/api/users/photos
📸 Photo fetch response status: 200
✅ Photos fetched: 0
```

## 🐛 If Still Getting 522 Error

### Check 1: Is Backend Actually Running?

```bash
pm2 list
# Should show circle-backend as "online"

pm2 logs circle-backend --lines 20
# Should show recent logs
```

### Check 2: Is Backend Accessible?

```bash
# From server
curl http://localhost:3000/health

# From outside
curl https://api.orincore.com/health
```

### Check 3: Check Nginx/Proxy Configuration

```bash
# If using Nginx
sudo nginx -t
sudo systemctl status nginx

# Check Nginx config
cat /etc/nginx/sites-available/api.orincore.com
```

### Check 4: Firewall/Security Groups

- Ensure port 3000 (or your backend port) is open
- Check cloud provider security groups
- Verify Cloudflare settings

## 📋 Complete Restart Checklist

```bash
# 1. Navigate to backend
cd /Users/orincore/Documents/circle\ prj/Backend

# 2. Build TypeScript
npm run build

# 3. Check compiled file exists
ls -la dist/server/routes/user-photos.routes.js

# 4. Restart server
pm2 restart circle-backend

# 5. Check status
pm2 status

# 6. View logs
pm2 logs circle-backend --lines 50

# 7. Test endpoint
curl http://localhost:3000/api/users/photos
```

## 🔍 Debug Mode

Add this to your backend to see all registered routes:

```typescript
// Add after all app.use() statements in app.ts
console.log('📍 Registered Routes:');
app._router.stack.forEach((middleware) => {
  if (middleware.route) {
    console.log(`  ${Object.keys(middleware.route.methods)} ${middleware.route.path}`);
  } else if (middleware.name === 'router') {
    middleware.handle.stack.forEach((handler) => {
      if (handler.route) {
        console.log(`  ${Object.keys(handler.route.methods)} ${handler.route.path}`);
      }
    });
  }
});
```

## ✅ Success Indicators

**Backend Logs Should Show:**
```
✅ Server started on port 3000
✅ Database connected
✅ Routes registered
```

**App Console Should Show:**
```
📸 Fetching photos from: https://api.orincore.com/api/users/photos
📸 Photo fetch response status: 200
✅ Photos fetched: 0
```

## 📞 Quick Commands Reference

```bash
# Restart backend
pm2 restart circle-backend

# View logs
pm2 logs circle-backend

# Check status
pm2 status

# Test health
curl https://api.orincore.com/health

# Test photos endpoint
curl -H "Authorization: Bearer TOKEN" \
  https://api.orincore.com/api/users/photos
```

## 🎯 Summary

**Everything is configured correctly in the code!**

The only thing needed is:
1. ✅ Build completed (already done)
2. ⏳ **Restart backend server** (you need to do this)
3. ⏳ Test the endpoint

**Run this command to fix:**
```bash
pm2 restart circle-backend
```

Then test the app again!
