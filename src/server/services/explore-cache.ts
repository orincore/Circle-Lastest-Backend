// Simple in-memory cache for explore data with daily refresh
interface CacheEntry {
  data: any;
  timestamp: number;
  expiresAt: number;
}

class ExploreCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds (reduced from 24 hours)

  set(key: string, data: any): void {
    const now = Date.now();
    const entry: CacheEntry = {
      data,
      timestamp: now,
      expiresAt: now + this.CACHE_DURATION
    };
    this.cache.set(key, entry);
    console.log(`Cache set for key: ${key}, expires at: ${new Date(entry.expiresAt).toISOString()}`);
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now > entry.expiresAt) {
      // Cache expired, remove it
      this.cache.delete(key);
      console.log(`Cache expired for key: ${key}`);
      return null;
    }

    console.log(`Cache hit for key: ${key}, age: ${Math.round((now - entry.timestamp) / 1000 / 60)} minutes`);
    return entry.data;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  clear(): void {
    this.cache.clear();
    console.log('Cache cleared');
  }

  // Invalidate cache for a specific user
  invalidateUser(userId: string): void {
    let removedCount = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(userId)) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      console.log(`Cache invalidated for user ${userId}: removed ${removedCount} entries`);
    }
  }

  // Clean up expired entries
  cleanup(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      console.log(`Cache cleanup: removed ${removedCount} expired entries`);
    }
  }

  // Get cache statistics
  getStats(): { size: number; entries: Array<{ key: string; age: number; expiresIn: number }> } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      age: Math.round((now - entry.timestamp) / 1000 / 60), // minutes
      expiresIn: Math.round((entry.expiresAt - now) / 1000 / 60) // minutes
    }));

    return {
      size: this.cache.size,
      entries
    };
  }
}

// Create singleton instance
export const exploreCache = new ExploreCache();

// Start cleanup interval (every hour)
setInterval(() => {
  exploreCache.cleanup();
}, 60 * 60 * 1000);

// Helper function to generate cache keys
export function generateCacheKey(userId: string, endpoint: string): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  return `${endpoint}:${userId}:${today}`;
}

// Helper function to get or set cached data
export async function getCachedOrFetch<T>(
  cacheKey: string,
  fetchFunction: () => Promise<T>
): Promise<T> {
  // Try to get from cache first
  const cached = exploreCache.get(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss, fetch fresh data
  console.log(`Cache miss for key: ${cacheKey}, fetching fresh data`);
  const freshData = await fetchFunction();
  
  // Store in cache
  exploreCache.set(cacheKey, freshData);
  
  return freshData;
}
