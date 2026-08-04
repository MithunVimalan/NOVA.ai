import crypto from 'node:crypto';

/**
 * Resolves the HMAC signing secret for JWTs.
 *
 * A hardcoded fallback secret would let anyone forge "owner" tokens, so we
 * never ship one. When JWT_SECRET is not provided we generate a random,
 * process-ephemeral secret instead: tokens stay valid for the lifetime of the
 * running server but cannot be forged by an attacker who read the source.
 */
function resolveJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET;
  if (envSecret && envSecret.length >= 16) {
    return envSecret;
  }
  if (envSecret) {
    console.warn('[Auth] JWT_SECRET is set but too short (<16 chars); ignoring it and generating an ephemeral secret.');
  } else {
    console.warn('[Auth] JWT_SECRET is not set. Generating a random ephemeral secret. Sessions will be invalidated on restart. Set JWT_SECRET for production.');
  }
  return crypto.randomBytes(48).toString('hex');
}

const JWT_SECRET = resolveJwtSecret();

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString();
}

/**
 * Signs a payload and returns a JSON Web Token
 */
export function generateJwt(payload: any, expiresInSeconds: number = 86400): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload = { ...payload, exp };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verifies a JWT and returns the parsed payload, or null if invalid/expired
 */
export function verifyJwt(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const decodedPayload = JSON.parse(base64UrlDecode(payload));
    if (decodedPayload.exp && decodedPayload.exp < Math.floor(Date.now() / 1000)) {
      return null; // Token expired
    }
    return decodedPayload;
  } catch {
    return null;
  }
}

/**
 * Hashes a password using Node's crypto scrypt algorithm with a random salt
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Verifies a password against a scrypt-derived hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    const [salt, key] = hash.split(':');
    if (!salt || !key) return false;
    return new Promise((resolve) => {
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return resolve(false);
        const keyBuf = Buffer.from(key, 'hex');
        if (keyBuf.length !== derivedKey.length) return resolve(false);
        resolve(crypto.timingSafeEqual(derivedKey, keyBuf));
      });
    });
  } catch {
    return false;
  }
}
