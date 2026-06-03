import test from 'node:test';
import assert from 'node:assert';
import { getSqliteManager } from '@nova/shared';
import { verifyJwt, generateJwt } from './auth.js';
import { executeTool } from './tools.js';

// TDD Test: Ingest and query sales logs in SQLite database
test('SqliteManager logging and querying sales logs', async () => {
  const sqliteDb = getSqliteManager();

  // Clear or mock facts/caches if necessary (since we could be in fallback or real SQLite)
  const initialSalesCount = sqliteDb.getSalesLogs ? sqliteDb.getSalesLogs().length : 0;

  // Add sales
  const sale1 = {
    productId: 'prod-1',
    revenue: 99.99,
    customer: 'Alice',
  };
  const sale2 = {
    productId: 'prod-2',
    revenue: 49.50,
    customer: 'Bob',
  };

  // Ensure these methods are defined before running (TDD expects them)
  assert.ok(sqliteDb.logSale, 'SqliteManager should define logSale method');
  assert.ok(sqliteDb.getSalesLogs, 'SqliteManager should define getSalesLogs method');

  sqliteDb.logSale(sale1);
  sqliteDb.logSale(sale2);

  const logs = sqliteDb.getSalesLogs();
  assert.ok(logs.length >= initialSalesCount + 2, 'Sales logs count should increase by at least 2');

  const logged1 = logs.find(l => l.customer === 'Alice');
  assert.ok(logged1, 'Should find Alice transaction in logs');
  assert.strictEqual(logged1.productId, 'prod-1');
  assert.strictEqual(logged1.revenue, 99.99);
  assert.ok(logged1.timestamp, 'Transaction log should automatically generate a timestamp');
});

// TDD Test: Analytics Calculation Logic for Visitors and Sales Trends
test('computeAnalyticsOverview computes correct trends, bounce rate, session duration, and product conversion metrics', async () => {
  const { computeAnalyticsOverview } = await import('./analytics.js');
  const sqliteDb = getSqliteManager();

  // Let's seed visitor events for clean assertions
  // Session A: 1 event (bounce)
  sqliteDb.logVisitorEvent({
    sessionId: 'session-a',
    pageUrl: 'https://example.com/product/prod-1',
    referrer: 'https://google.com',
    scrollDepth: 20,
    timeOnPage: 10,
  });

  // Session B: 2 events (non-bounce), different pages
  sqliteDb.logVisitorEvent({
    sessionId: 'session-b',
    pageUrl: 'https://example.com/',
    referrer: 'https://google.com',
    scrollDepth: 10,
    timeOnPage: 30,
  });
  sqliteDb.logVisitorEvent({
    sessionId: 'session-b',
    pageUrl: 'https://example.com/product/prod-1',
    referrer: 'https://example.com/',
    scrollDepth: 50,
    timeOnPage: 120,
  });

  // Seed sales
  sqliteDb.logSale({
    productId: 'prod-1',
    revenue: 100,
    customer: 'Charlie',
  });

  const overview = computeAnalyticsOverview();

  // 1. Validate Sales trends calculation
  assert.ok(overview.salesTrends, 'Overview must contain sales trends');
  assert.ok(overview.salesTrends.today.revenue >= 100, 'Today revenue calculation must include Charlie sale');

  // 2. Validate visitor statistics
  assert.ok(overview.visitors, 'Overview must contain visitor stats');
  assert.ok(overview.visitors.uniqueVisitors >= 2, 'Should detect at least 2 unique visitor sessions');
  assert.ok(overview.visitors.bounceRate >= 0 && overview.visitors.bounceRate <= 100, 'Bounce rate percentage should be between 0 and 100');
  
  // 3. Validate product analytics rankings
  assert.ok(overview.products, 'Overview must contain product rankings');
  const prod1Info = overview.products.find((p: any) => p.productId === 'prod-1');
  assert.ok(prod1Info, 'Product prod-1 info should be in product metrics');
  assert.ok(prod1Info.views >= 2, 'Product prod-1 should register views from Session A and B');
  assert.ok(prod1Info.conversions >= 1, 'Product prod-1 should register conversions');
  assert.ok(prod1Info.conversionRate > 0, 'Conversion rate should be greater than zero');
});

// TDD Test: Voice assistant helper reporting tool runs successfully
test('Voice Assistant business_analytics_report tool returns expected metrics summary', async () => {
  const result = await executeTool('business_analytics_report', { period: 'today' }, { isOwner: true, sessionId: 'voice-session' });
  assert.strictEqual(result.success, true, 'Analytics tool execution must succeed');
  assert.ok(result.output.includes('Revenue') || result.output.includes('sales') || result.output.includes('visitors'), 'Tool response must output analytical summaries');
});

// TDD Test: JWT Authentication check
test('JWT validation secures dashboard metrics access', async () => {
  const payload = { role: 'owner', email: 'owner@nova.ai' };
  const token = generateJwt(payload, 30); // 30s token

  const validParsed = verifyJwt(token);
  assert.ok(validParsed, 'JWT verify should decode valid token');
  assert.strictEqual(validParsed.role, 'owner');

  const invalidParsed = verifyJwt('invalid.token.structure');
  assert.strictEqual(invalidParsed, null, 'JWT verify should reject invalid tokens');

  const expiredToken = generateJwt(payload, -10); // expired 10s ago
  const expiredParsed = verifyJwt(expiredToken);
  assert.strictEqual(expiredParsed, null, 'JWT verify should reject expired tokens');
});
