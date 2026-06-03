import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// TDD Test: Git ignores env files compliance check
test('Compliance Checker verifies that .env is ignored in gitignore', async () => {
  const { ComplianceChecker } = await import('./compliance.js');
  const checker = new ComplianceChecker();

  const isIgnored = checker.checkGitignoreForEnv();
  assert.strictEqual(isIgnored, true, '.env must be present in .gitignore');
});

// TDD Test: No hardcoded secrets committed check
test('Compliance Checker scans source files for hardcoded API keys or credentials', async () => {
  const { ComplianceChecker } = await import('./compliance.js');
  const checker = new ComplianceChecker();

  // Test scan on a sample string
  const cleanCode = 'const apiKey = process.env.API_KEY || "";';
  const dirtyCode = 'const stripeKey = "sk_live_51Ny8923hjkHsd912hklasd";';

  assert.strictEqual(checker.scanContentForSecrets(cleanCode), true, 'Clean environment-injected code must pass check');
  assert.strictEqual(checker.scanContentForSecrets(dirtyCode), false, 'Hardcoded Stripe live key must trigger security scan failure');
});

// TDD Test: Secure Logging check
test('Secure Logger filters passwords, credentials, and tokens from system logs', async () => {
  const { getSecureLogger } = await import('./logger.js');
  const logger = getSecureLogger();

  let loggedOutput = '';
  // Intercept stdout
  const originalLog = console.log;
  console.log = (...args) => {
    loggedOutput += args.join(' ');
  };

  try {
    logger.info('Authenticating user', { password: 'myPassword123', secretToken: 'sk_live_xyz' });
    
    assert.ok(!loggedOutput.includes('myPassword123'), 'Passwords must never be output to the console logs');
    assert.ok(!loggedOutput.includes('sk_live_xyz'), 'Tokens and secrets must never be logged');
    assert.ok(loggedOutput.includes('[REDACTED]'), 'Sensitive fields must be replaced with [REDACTED]');
  } finally {
    console.log = originalLog;
  }
});

// TDD Test: Node Crypto Password Hashing check
test('Crypto utilities hash passwords and verify them securely', async () => {
  const { hashPassword, verifyPassword } = await import('./auth.js');

  const password = 'mySuperStrongAdminPassword!23';
  const hashed = await hashPassword(password);

  assert.ok(hashed, 'Password hashing should return a non-empty string');
  assert.notStrictEqual(hashed, password, 'Hashed password must not match plain text password');

  const isMatch = await verifyPassword(password, hashed);
  assert.strictEqual(isMatch, true, 'Correct password verification must succeed');

  const isWrongMatch = await verifyPassword('wrongpassword', hashed);
  assert.strictEqual(isWrongMatch, false, 'Incorrect password verification must fail');
});
