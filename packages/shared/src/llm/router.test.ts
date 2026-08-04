import test from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../config.js';
import { generateChatResponse } from './router.js';

interface CapturedRequest {
  url: string;
  body: any;
}

function stubFetch(handler: (req: CapturedRequest) => any): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const req = { url, body: JSON.parse(init.body) };
    captured.push(req);
    return handler(req);
  };
  return captured;
}

function jsonResponse(payload: any, ok = true, status = 200, statusText = 'OK') {
  return {
    ok,
    status,
    statusText,
    json: async () => payload,
  };
}

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

test('generateChatResponse posts to the Ollama chat endpoint and returns the message content', async () => {
  const captured = stubFetch(() => jsonResponse({ message: { content: 'Hello from NOVA' } }));

  const reply = await generateChatResponse([{ role: 'user', content: 'Hi' }]);

  assert.strictEqual(reply, 'Hello from NOVA');
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].url, `${loadConfig().ollamaUrl}/api/chat`);
  assert.strictEqual(captured[0].body.stream, false);
  assert.deepStrictEqual(captured[0].body.messages, [{ role: 'user', content: 'Hi' }]);
});

test('generateChatResponse routes to the fast model with a higher temperature by default', async () => {
  const config = loadConfig();
  const captured = stubFetch(() => jsonResponse({ message: { content: 'ok' } }));

  await generateChatResponse([{ role: 'user', content: 'Quick question' }]);

  assert.strictEqual(captured[0].body.model, config.modelRouting.fast);
  assert.strictEqual(captured[0].body.options.temperature, 0.7);
});

test('generateChatResponse routes to the reasoning model with a lower temperature when requested', async () => {
  const config = loadConfig();
  const captured = stubFetch(() => jsonResponse({ message: { content: 'ok' } }));

  await generateChatResponse([{ role: 'user', content: 'Solve this' }], true);

  assert.strictEqual(captured[0].body.model, config.modelRouting.reasoning);
  assert.strictEqual(captured[0].body.options.temperature, 0.2);
});

test('generateChatResponse returns the offline fallback guidance on an HTTP error', async () => {
  const config = loadConfig();
  stubFetch(() => jsonResponse({}, false, 503, 'Service Unavailable'));

  const reply = await generateChatResponse([{ role: 'user', content: 'Hi' }]);

  assert.match(reply, /NOVA LLM Fallback Mode/);
  assert.match(reply, /HTTP Error 503/);
  assert.ok(reply.includes(config.ollamaUrl), 'Fallback must tell the user which Ollama URL was used');
  assert.ok(reply.includes(config.modelRouting.fast), 'Fallback must name the model that was attempted');
});

test('generateChatResponse falls back when the response structure is invalid', async () => {
  stubFetch(() => jsonResponse({ unexpected: true }));

  const reply = await generateChatResponse([{ role: 'user', content: 'Hi' }]);

  assert.match(reply, /Invalid response structure from Ollama/);
});

test('generateChatResponse falls back when the network connection fails', async () => {
  (globalThis as any).fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  const reply = await generateChatResponse([{ role: 'user', content: 'Hi' }]);

  assert.match(reply, /NOVA LLM Fallback Mode/);
  assert.match(reply, /ECONNREFUSED/);
});
