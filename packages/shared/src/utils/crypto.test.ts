import test from 'node:test';
import assert from 'node:assert';
import { encryptText, decryptText } from './crypto.js';

const KEY = 'nova-test-passphrase';

test('encryptText returns iv:tag:ciphertext and round-trips through decryptText', () => {
  const plaintext = 'telegram-bot-token-1234567890';
  const cipherText = encryptText(plaintext, KEY);

  const parts = cipherText.split(':');
  assert.strictEqual(parts.length, 3, 'Cipher text must contain iv, tag and payload segments');
  assert.strictEqual(parts[0].length, 24, 'IV must be a 12-byte hex string');
  assert.strictEqual(parts[1].length, 32, 'GCM auth tag must be a 16-byte hex string');
  assert.ok(!cipherText.includes(plaintext), 'Plaintext must not leak into the cipher text');

  assert.strictEqual(decryptText(cipherText, KEY), plaintext);
});

test('encryptText produces a unique IV per invocation', () => {
  const first = encryptText('same message', KEY);
  const second = encryptText('same message', KEY);

  assert.notStrictEqual(first, second, 'Identical plaintexts must not produce identical cipher texts');
  assert.strictEqual(decryptText(first, KEY), decryptText(second, KEY));
});

test('encryptText and decryptText short-circuit on empty input', () => {
  assert.strictEqual(encryptText('', KEY), '');
  assert.strictEqual(decryptText('', KEY), '');
});

test('decryptText rejects a malformed cipher text format', () => {
  assert.throws(
    () => decryptText('not-a-valid-payload', KEY),
    /Invalid cipher text format/
  );
});

test('decryptText fails on a wrong key or tampered payload', () => {
  const cipherText = encryptText('confidential', KEY);

  assert.throws(() => decryptText(cipherText, 'wrong-passphrase'));

  const [iv, tag, payload] = cipherText.split(':');
  const flipped = payload.startsWith('a') ? 'b' + payload.slice(1) : 'a' + payload.slice(1);
  assert.throws(() => decryptText(`${iv}:${tag}:${flipped}`, KEY));
});

test('encryptText supports unicode and long payloads', () => {
  const plaintext = 'héllo wörld — 🚀 '.repeat(200);
  assert.strictEqual(decryptText(encryptText(plaintext, KEY), KEY), plaintext);
});
