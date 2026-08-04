import test from 'node:test';
import assert from 'node:assert';
import { RateLimiter, getRateLimiter } from './limiter.js';

// Exercise the in-memory sliding window rather than a shared Redis backend.
delete process.env.REDIS_URL;

test('getRateLimiter returns a shared singleton instance', () => {
  assert.strictEqual(getRateLimiter(), getRateLimiter());
});

test('Requests below the threshold are allowed and the threshold itself is inclusive', async () => {
  const limiter = new RateLimiter();

  assert.strictEqual(await limiter.isRateLimited('tenant-a', 3, 60), false);
  assert.strictEqual(await limiter.isRateLimited('tenant-a', 3, 60), false);
  assert.strictEqual(await limiter.isRateLimited('tenant-a', 3, 60), false, 'The third request still sits on the limit');
});

test('Requests above the threshold are blocked', async () => {
  const limiter = new RateLimiter();

  for (let i = 0; i < 2; i++) {
    assert.strictEqual(await limiter.isRateLimited('tenant-b', 2, 60), false);
  }

  assert.strictEqual(await limiter.isRateLimited('tenant-b', 2, 60), true, 'Exceeding the limit must block the request');
  assert.strictEqual(await limiter.isRateLimited('tenant-b', 2, 60), true, 'Further requests stay blocked inside the window');
});

test('Rate limit buckets are isolated per key', async () => {
  const limiter = new RateLimiter();

  assert.strictEqual(await limiter.isRateLimited('ip-1.1.1.1', 1, 60), false);
  assert.strictEqual(await limiter.isRateLimited('ip-1.1.1.1', 1, 60), true);

  assert.strictEqual(await limiter.isRateLimited('ip-2.2.2.2', 1, 60), false, 'A different key must not inherit another key usage');
});

test('The sliding window forgets timestamps once they age out', async () => {
  const limiter = new RateLimiter();

  assert.strictEqual(await limiter.isRateLimited('tenant-window', 1, 1), false);
  assert.strictEqual(await limiter.isRateLimited('tenant-window', 1, 1), true);

  await new Promise(resolve => setTimeout(resolve, 1100));

  assert.strictEqual(await limiter.isRateLimited('tenant-window', 1, 1), false, 'Expired timestamps must leave the sliding window');
});

test('A zero limit blocks the very first request', async () => {
  const limiter = new RateLimiter();

  assert.strictEqual(await limiter.isRateLimited('tenant-zero', 0, 60), true);
});
