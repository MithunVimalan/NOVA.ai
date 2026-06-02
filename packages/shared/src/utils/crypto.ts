import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16;

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param text The plaintext to encrypt
 * @param secretKey The raw key passphrase (hashed to 256 bits automatically)
 * @returns Combined IV, authentication tag, and ciphertext joined by colons
 */
export function encryptText(text: string, secretKey: string): string {
  if (!text) return '';
  const key = crypto.createHash('sha256').update(secretKey).digest();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 * @param cipherText The combined IV, tag, and ciphertext string
 * @param secretKey The passphrase used for encryption
 * @returns The original decrypted plaintext
 */
export function decryptText(cipherText: string, secretKey: string): string {
  if (!cipherText) return '';
  const key = crypto.createHash('sha256').update(secretKey).digest();
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid cipher text format. Expected iv:tag:ciphertext');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
