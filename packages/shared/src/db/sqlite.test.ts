import test from 'node:test';
import assert from 'node:assert';
import { SqliteManager, getSqliteManager } from './sqlite.js';

// The manager transparently uses better-sqlite3 when the native binding is
// available and a local JSON store otherwise, so every assertion below has to
// hold for both backends.
const db = new SqliteManager();
const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test('getSqliteManager returns a shared singleton instance', () => {
  assert.strictEqual(getSqliteManager(), getSqliteManager());
});

test('Facts: unknown keys resolve to null and writes are read back', () => {
  const key = `${runId}-fact`;

  assert.strictEqual(db.getFact(key), null, 'Missing facts must resolve to null');

  db.setFact(key, 'first value');
  assert.strictEqual(db.getFact(key), 'first value');
});

test('Facts: repeated writes upsert instead of duplicating the key', () => {
  const key = `${runId}-upsert`;

  db.setFact(key, 'original');
  db.setFact(key, 'updated');

  assert.strictEqual(db.getFact(key), 'updated');

  const all = db.getAllFacts();
  assert.strictEqual(all[key], 'updated', 'getAllFacts must expose the latest value');
});

test('Visitor events are persisted and returned newest first', () => {
  const sessionId = `${runId}-visitor`;

  db.logVisitorEvent({ sessionId, pageUrl: '/pricing', referrer: 'google.com', scrollDepth: 40, timeOnPage: 12 });
  db.logVisitorEvent({ sessionId, pageUrl: '/checkout', referrer: '/pricing', scrollDepth: 90, timeOnPage: 55 });

  const logs = db.getVisitorLogs().filter(v => v.sessionId === sessionId);
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(logs[0].pageUrl, '/checkout', 'Most recent visitor event must be returned first');
  assert.strictEqual(logs[1].pageUrl, '/pricing');
  assert.strictEqual(logs[0].scrollDepth, 90);
  assert.ok(!Number.isNaN(Date.parse(logs[0].timestamp)), 'Events must be stamped with an ISO timestamp');
});

test('Leads are captured and returned newest first', () => {
  const sessionId = `${runId}-lead`;

  db.addLead({ sessionId, name: 'Ada Lovelace', email: 'ada@example.com' });
  db.addLead({ sessionId, name: 'Alan Turing', email: 'alan@example.com' });

  const leads = db.getLeads().filter(l => l.sessionId === sessionId);
  assert.strictEqual(leads.length, 2);
  assert.strictEqual(leads[0].name, 'Alan Turing');
  assert.strictEqual(leads[1].email, 'ada@example.com');
  assert.ok(!Number.isNaN(Date.parse(leads[0].capturedAt)));
});

test('Tenants: unknown ids resolve to null, and inserts are upserted by id', () => {
  const tenantId = `${runId}-tenant`;

  assert.strictEqual(db.getTenant(tenantId), null);

  db.addTenant({
    id: tenantId,
    name: 'Acme Corp',
    telegramEnabled: 1,
    telegramToken: 'tg-token',
    whatsappEnabled: 0,
    whatsappToken: '',
    stripeStatus: 'active',
  });

  const stored = db.getTenant(tenantId);
  assert.ok(stored);
  assert.strictEqual(stored.name, 'Acme Corp');
  assert.strictEqual(stored.telegramToken, 'tg-token');

  db.addTenant({
    id: tenantId,
    name: 'Acme Corp Renamed',
    telegramEnabled: 0,
    telegramToken: '',
    whatsappEnabled: 1,
    whatsappToken: 'wa-token',
    stripeStatus: 'cancelled',
  });

  const updated = db.getTenant(tenantId);
  assert.strictEqual(updated?.name, 'Acme Corp Renamed');
  assert.strictEqual(updated?.whatsappToken, 'wa-token');
  assert.strictEqual(updated?.stripeStatus, 'cancelled');

  const matching = db.getAllTenants().filter(t => t.id === tenantId);
  assert.strictEqual(matching.length, 1, 'Upserting a tenant must not create a duplicate row');
});

test('Sales logs default the timestamp and are returned newest first', () => {
  const productPrefix = `${runId}-product`;

  db.logSale({ productId: `${productPrefix}-a`, revenue: 19.99, customer: 'ada@example.com', timestamp: '2024-01-01T00:00:00.000Z' });
  db.logSale({ productId: `${productPrefix}-b`, revenue: 149.5, customer: 'alan@example.com' });

  const sales = db.getSalesLogs().filter(s => s.productId.startsWith(productPrefix));
  assert.strictEqual(sales.length, 2);
  assert.strictEqual(sales[0].productId, `${productPrefix}-b`, 'Latest sale must be returned first');
  assert.strictEqual(sales[0].revenue, 149.5);
  assert.ok(!Number.isNaN(Date.parse(sales[0].timestamp)), 'Omitted timestamps must default to now');
  assert.strictEqual(sales[1].timestamp, '2024-01-01T00:00:00.000Z', 'Explicit timestamps must be preserved');
});

test('close() is safe to call on the active backend', () => {
  const disposable = new SqliteManager();
  assert.doesNotThrow(() => disposable.close());
});
