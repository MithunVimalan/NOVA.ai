import test from 'node:test';
import assert from 'node:assert';
import { VectorDbManager, getVectorDbManager } from './lancedb.js';

const originalFetch = globalThis.fetch;

// Force the deterministic offline embedding path so the suite never depends on
// a running Ollama instance.
function forceOfflineEmbeddings() {
  (globalThis as any).fetch = async () => {
    throw new Error('Ollama offline');
  };
}

test.before(() => forceOfflineEmbeddings());
test.after(() => {
  (globalThis as any).fetch = originalFetch;
});

test('getVectorDbManager returns a shared singleton instance', () => {
  assert.strictEqual(getVectorDbManager(), getVectorDbManager());
});

test('getEmbedding uses the local Ollama embeddings endpoint when it is reachable', async () => {
  const calls: any[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) };
  };

  try {
    const vector = await new VectorDbManager().getEmbedding('hello', 'phi3:mini');

    assert.deepStrictEqual(vector, [0.1, 0.2, 0.3]);
    assert.match(calls[0].url, /\/api\/embeddings$/);
    assert.strictEqual(calls[0].body.model, 'phi3:mini');
    assert.strictEqual(calls[0].body.prompt, 'hello');
  } finally {
    forceOfflineEmbeddings();
  }
});

test('getEmbedding falls back to a deterministic normalized 128-dim vector when Ollama is offline', async () => {
  const db = new VectorDbManager();

  const first = await db.getEmbedding('nova assistant');
  const second = await db.getEmbedding('nova assistant');
  const other = await db.getEmbedding('something entirely different');

  assert.strictEqual(first.length, 128);
  assert.deepStrictEqual(first, second, 'The offline embedding must be deterministic');
  assert.notDeepStrictEqual(first, other, 'Different inputs must produce different embeddings');

  const magnitude = Math.sqrt(first.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-9, 'Fallback embeddings must be L2 normalized');
});

test('getEmbedding is case insensitive in the offline fallback', async () => {
  const db = new VectorDbManager();

  assert.deepStrictEqual(await db.getEmbedding('NOVA'), await db.getEmbedding('nova'));
});

test('Episodic memory search ranks the semantically closest conversation first', async () => {
  const db = new VectorDbManager();
  const marker = `episodic-${Date.now()}`;

  await db.addEpisodicMemory(`${marker}-1`, `What is the refund policy ${marker}?`, 'Refunds are processed within 14 days.');
  await db.addEpisodicMemory(`${marker}-2`, `Where is the office ${marker}?`, 'We are fully remote.');

  const results = await db.searchEpisodicMemory(
    `User: What is the refund policy ${marker}?\nAssistant: Refunds are processed within 14 days.`,
    1000
  );

  assert.ok(results.length > 0, 'Search must return stored episodic memories');
  assert.ok(results.every((r: any) => r.table === 'episodic'), 'Episodic search must not return catalog records');

  const scores = results.map((r: any) => r.score);
  assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a), 'Results must be ranked by descending similarity');

  const exactMatch = results.find((r: any) => r.metadata.sessionId === `${marker}-1`);
  assert.ok(exactMatch, 'The stored conversation must be retrievable');
  assert.ok(exactMatch.score > 0.99, 'An exact query match must score near 1');
  assert.ok(
    exactMatch.score >= Math.max(...scores) - 1e-9,
    'No unrelated memory may outrank an exact match'
  );
});

test('searchEpisodicMemory honours the result limit', async () => {
  const db = new VectorDbManager();
  const marker = `limit-${Date.now()}`;

  await db.addEpisodicMemory(`${marker}-a`, 'question a', 'answer a');
  await db.addEpisodicMemory(`${marker}-b`, 'question b', 'answer b');
  await db.addEpisodicMemory(`${marker}-c`, 'question c', 'answer c');

  const results = await db.searchEpisodicMemory('question', 2);
  assert.strictEqual(results.length, 2);
});

test('Catalog documents are searchable, keep their metadata, and can be cleared', async () => {
  const db = new VectorDbManager();
  const marker = `catalog-${Date.now()}`;

  await db.addCatalogDoc(`NOVA Pro subscription ${marker} costs 49 dollars per month.`, { productId: `${marker}-pro` });
  await db.addCatalogDoc(`NOVA Free tier ${marker} includes limited usage.`, { productId: `${marker}-free` });

  const results = await db.searchCatalog(`NOVA Pro subscription ${marker} costs 49 dollars per month.`, 1000);

  assert.ok(results.length > 0);
  assert.ok(results.every((r: any) => r.table === 'catalog'), 'Catalog search must not return episodic records');

  const exactMatch = results.find((r: any) => r.metadata.productId === `${marker}-pro`);
  assert.ok(exactMatch, 'The indexed catalog document must be retrievable');
  assert.ok(exactMatch.score > 0.99, 'An exact query match must score near 1');
  assert.ok(
    exactMatch.score >= Math.max(...results.map((r: any) => r.score)) - 1e-9,
    'No unrelated document may outrank an exact match'
  );

  db.clearCatalog();
  const afterClear = await db.searchCatalog(`NOVA Pro subscription ${marker}`, 2);
  assert.strictEqual(afterClear.length, 0, 'clearCatalog must drop every indexed catalog document');
});
