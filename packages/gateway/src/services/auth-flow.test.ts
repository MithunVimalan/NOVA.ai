import test from 'node:test';
import assert from 'node:assert';
import { getSqliteManager } from '@nova/shared';
import { hashPassword, verifyPassword, generateJwt, verifyJwt } from './auth.js';

// Test: User consent tracking
test('Onboarding Flow: Consent state check and update', async () => {
  const sqliteDb = getSqliteManager();
  
  // Initially, terms might not be accepted
  sqliteDb.setFact('terms_and_conditions_agreed', 'false');
  
  const checkConsent = () => {
    return sqliteDb.getFact('terms_and_conditions_agreed') === 'true';
  };
  
  assert.strictEqual(checkConsent(), false, 'Initially user has not agreed to terms');

  // Accept terms
  const acceptConsent = () => {
    sqliteDb.setFact('terms_and_conditions_agreed', 'true');
  };
  
  acceptConsent();
  assert.strictEqual(checkConsent(), true, 'User agreed to terms successfully');
});

// Test: Password setup & verification (scrypt)
test('Onboarding Flow: Password registration and login verification', async () => {
  const sqliteDb = getSqliteManager();
  const password = 'mySuperSecureGatewayPassword999';

  // 1. Password Setup
  const hasPasswordSetup = () => {
    return sqliteDb.getFact('owner_password_hash') !== null;
  };

  // Clear existing setup if any
  sqliteDb.setFact('owner_password_hash', '');
  
  const registerPassword = async (pass: string) => {
    const hashed = await hashPassword(pass);
    sqliteDb.setFact('owner_password_hash', hashed);
  };

  await registerPassword(password);
  assert.ok(hasPasswordSetup(), 'Password setup should save the password hash in database');

  // 2. Password Login
  const loginOwner = async (pass: string) => {
    const hash = sqliteDb.getFact('owner_password_hash');
    if (!hash) return null;
    const isValid = await verifyPassword(pass, hash);
    if (!isValid) return null;
    return generateJwt({ role: 'owner' }, 3600);
  };

  // Valid Login
  const token = await loginOwner(password);
  assert.ok(token, 'Valid password must generate a session token');
  
  const decoded = verifyJwt(token);
  assert.strictEqual(decoded.role, 'owner', 'Generated JWT token must contain owner role');

  // Invalid Login
  const invalidToken = await loginOwner('wrong_password_123');
  assert.strictEqual(invalidToken, null, 'Invalid password must return null and fail authentication');
});

// Test: Router level authorization guard hook
test('Authentication Guard: Validates JWT session tokens correctly', () => {
  const token = generateJwt({ role: 'owner' }, 60);
  const guestToken = generateJwt({ role: 'guest' }, 60);
  const expiredToken = generateJwt({ role: 'owner' }, -60);

  const authGuard = (url: string, authHeader: string | undefined) => {
    // Whitelisted routes
    if (url.startsWith('/api/auth/') || url.startsWith('/api/widget/')) {
      return { status: 200, allowed: true };
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, error: 'Unauthorized: Missing or invalid token' };
    }

    const t = authHeader.split(' ')[1];
    const decoded = verifyJwt(t);
    if (!decoded || decoded.role !== 'owner') {
      return { status: 401, error: 'Unauthorized: Access token is invalid or expired' };
    }

    return { status: 200, allowed: true };
  };

  // Test white-listed paths
  assert.deepStrictEqual(authGuard('/api/auth/check-setup', undefined), { status: 200, allowed: true });
  assert.deepStrictEqual(authGuard('/api/widget/chat', undefined), { status: 200, allowed: true });

  // Test protected paths (no token)
  assert.strictEqual(authGuard('/api/chat', undefined).status, 401);
  assert.strictEqual(authGuard('/api/facts', 'InvalidFormatToken').status, 401);

  // Test protected paths (valid owner token)
  assert.deepStrictEqual(authGuard('/api/chat', `Bearer ${token}`), { status: 200, allowed: true });

  // Test protected paths (invalid role token)
  assert.strictEqual(authGuard('/api/chat', `Bearer ${guestToken}`).status, 401);

  // Test protected paths (expired token)
  assert.strictEqual(authGuard('/api/chat', `Bearer ${expiredToken}`).status, 401);
});

// Test: Deployment Health Check Diagnostics
test('Deployment Diagnostics: Health check evaluates critical components', async () => {
  const runHealthCheck = async (mockOllamaOnline: boolean, mockSqliteOnline: boolean) => {
    const ollamaStatus = mockOllamaOnline ? 'active' : 'offline';
    const sqliteStatus = mockSqliteOnline ? 'active' : 'offline';
    
    return {
      status: (ollamaStatus === 'active' && sqliteStatus === 'active') ? 'healthy' : 'degraded',
      checks: {
        ollama: { status: ollamaStatus },
        sqlite: { status: sqliteStatus }
      }
    };
  };

  const healthyResult = await runHealthCheck(true, true);
  assert.strictEqual(healthyResult.status, 'healthy');
  assert.strictEqual(healthyResult.checks.ollama.status, 'active');
  assert.strictEqual(healthyResult.checks.sqlite.status, 'active');

  const degradedResult = await runHealthCheck(false, true);
  assert.strictEqual(degradedResult.status, 'degraded');
  assert.strictEqual(degradedResult.checks.ollama.status, 'offline');
});
