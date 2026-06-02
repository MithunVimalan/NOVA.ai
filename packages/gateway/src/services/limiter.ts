export class RateLimiter {
  private inMemoryCache: Map<string, number[]> = new Map();
  private redisClient: any = null;

  constructor() {
    this.initializeRedis();
  }

  private async initializeRedis() {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      try {
        const IoRedisClass = (await import('ioredis')).default;
        const RedisConstructor: any = (IoRedisClass as any).Redis || IoRedisClass;
        this.redisClient = new RedisConstructor(redisUrl, { maxRetriesPerRequest: 3 });
        console.log('[RateLimiter] Connected to Redis for rate limiting.');
      } catch (err: any) {
        console.warn('[RateLimiter] Failed to load ioredis, falling back to local memory.', err.message);
      }
    }
  }

  /**
   * Checks if a request key exceeds the specified rate limit
   * @param key unique request identifier (IP, user ID, tenant ID)
   * @param limit maximum request threshold in the time window
   * @param windowSeconds time window size in seconds
   * @returns true if rate limited (blocked), false if allowed
   */
  async isRateLimited(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const nowMs = Date.now();

    if (this.redisClient) {
      try {
        const redisKey = `ratelimit:${key}`;
        const transaction = this.redisClient.multi();
        
        // Remove old entries
        transaction.zremrangebyscore(redisKey, 0, nowMs - windowSeconds * 1000);
        // Add current request timestamp
        transaction.zadd(redisKey, nowMs, `${nowMs}-${Math.random()}`);
        // Fetch remaining requests count
        transaction.zcard(redisKey);
        // Set TTL on key
        transaction.expire(redisKey, windowSeconds);

        const results = await transaction.exec();
        const count = results?.[2]?.[1] as number || 0;

        return count > limit;
      } catch (err: any) {
        console.error('[RateLimiter] Redis command failed, falling back to in-memory check.', err.message);
      }
    }

    // In-Memory Sliding Window Fallback
    const timestamps = this.inMemoryCache.get(key) || [];
    const cutoff = nowMs - windowSeconds * 1000;

    // Filter out old timestamps
    const activeTimestamps = timestamps.filter(t => t > cutoff);
    activeTimestamps.push(nowMs);

    this.inMemoryCache.set(key, activeTimestamps);

    return activeTimestamps.length > limit;
  }
}

let rateLimiterInstance: RateLimiter | null = null;
export function getRateLimiter(): RateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter();
  }
  return rateLimiterInstance;
}
