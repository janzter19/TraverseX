import crypto from 'node:crypto';

const KEYLEN = 64;
const ENCRYPTION_VERSION = 'aes-256-gcm-v1';

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('session_secret_missing');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${ENCRYPTION_VERSION}$${iv.toString('base64url')}$${cipher.getAuthTag().toString('base64url')}$${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  const [version, ivValue, tagValue, payload] = String(value ?? '').split('$');
  if (version !== ENCRYPTION_VERSION || !ivValue || !tagValue || !payload) throw new Error('project_mysql_password_unavailable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
}
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, encoded) {
  const [scheme, salt, expected] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function safeError(error) {
  return error?.code ? String(error.code) : 'internal_error';
}
