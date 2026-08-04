/**
 * Creates an ioredis client from `REDIS_URL`, or returns null when Redis is not
 * configured or the driver cannot be loaded (callers then use local fallbacks).
 */
export async function createRedisClient(
  logLabel: string,
  options: Record<string, unknown>
): Promise<any | null> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  try {
    const IoRedisClass = (await import('ioredis')).default;
    const RedisConstructor: any = (IoRedisClass as any).Redis || IoRedisClass;
    const client = new RedisConstructor(redisUrl, options);
    console.log(`${logLabel} Connected to Redis at ${redisUrl}.`);
    return client;
  } catch (err: any) {
    console.warn(`${logLabel} Failed to load ioredis, falling back to local memory.`, err.message);
    return null;
  }
}
