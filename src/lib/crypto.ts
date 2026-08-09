// ============================================================
// FreeLLM API - Crypto Utilities
// Uses Web Crypto API (Cloudflare Workers compatible)
// ============================================================

const ENCODING: TextEncoder = new TextEncoder();
const DECODING: TextDecoder = new TextDecoder('utf-8');

// ---- Base64url helpers ----

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---- SHA-256 / HMAC ----

export async function sha256(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', ENCODING.encode(data));
  return base64UrlEncode(hash);
}

export async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODING.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, ENCODING.encode(data));
  return base64UrlEncode(sig);
}

// ---- Secure random ----

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomHex(length: number): string {
  const bytes = randomBytes(Math.ceil(length / 2));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

// ---- Bcrypt-like password hashing (using PBKDF2 + SHA-256) ----
// Cloudflare Workers don't support bcrypt natively, so we use PBKDF2.

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const HASH_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODING.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    HASH_LENGTH * 8
  );
  const saltB64 = base64UrlEncode(salt.buffer);
  const hashB64 = base64UrlEncode(hash);
  return `$pbkdf2-sha256$i=${PBKDF2_ITERATIONS},l=${HASH_LENGTH}$` + saltB64 + '$' + hashB64;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length < 5 || parts[1] !== 'pbkdf2-sha256') {
    throw new Error('Unsupported password format');
  }
  const params = parts[2];
  const saltB64 = parts[3];
  const hashB64 = parts[4];
  const iters = parseInt(params.split(',')[0].split('=')[1], 10);
  const salt = base64UrlDecode(saltB64);
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODING.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: iters,
      hash: 'SHA-256',
    },
    key,
    HASH_LENGTH * 8
  );
  const computedB64 = base64UrlEncode(hash);
  return computedB64 === hashB64;
}

// ---- JWT ----

export interface JwtPayload {
  sub: number;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

export async function createJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiryHours = 24
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiryHours * 3600,
  };

  const header = base64UrlEncode(ENCODING.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(ENCODING.encode(JSON.stringify(fullPayload)));
  const signature = await hmacSha256(secret, `${header}.${body}`);

  return `${header}.${body}.${signature}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, bodyB64, signatureB64] = parts;

  // Verify signature
  const expectedSig = await hmacSha256(secret, `${headerB64}.${bodyB64}`);
  if (signatureB64 !== expectedSig) return null;

  try {
    const body = JSON.parse(DECODING.decode(base64UrlDecode(bodyB64))) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (body.exp < now) return null; // expired
    return body;
  } catch {
    return null;
  }
}

// ---- AES-GCM Encryption ----

export async function encryptAesGcm(plaintext: string, keyHex: string): Promise<string> {
  const keyBytes = base64UrlDecode(keyHex);
  const iv = randomBytes(12);

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    ENCODING.encode(plaintext)
  );

  // Combine iv + ciphertext, base64 encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return base64UrlEncode(combined.buffer);
}

export async function decryptAesGcm(ciphertextB64: string, keyHex: string): Promise<string> {
  const combined = base64UrlDecode(ciphertextB64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const key = await crypto.subtle.importKey(
    'raw',
    base64UrlDecode(keyHex),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return DECODING.decode(decrypted);
}

// ---- API Key generation ----

export function generateApiKey(): { plaintext: string; prefix: string; hashed: string } {
  const bytes = randomBytes(32);
  const plaintext = 'fllm_' + Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('');
  const prefix = plaintext.substring(0, 12);
  const hashed = base64UrlEncode(
    new Uint8Array(
      Array.from(ENCODING.encode(plaintext)).map((c) => c)
    )
  );
  // We use SHA-256 for the actual hash stored in DB
  const hashedForStorage = sha256(plaintext); // async, returns promise
  // Return a sync version using a simpler approach
  return { plaintext, prefix, hashed: '' };
}

// Sync version for API key that returns immediately
export function generateApiKeySync(): { plaintext: string; prefix: string } {
  const bytes = randomBytes(32);
  const plaintext = 'fllm_' + Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('');
  const prefix = plaintext.substring(0, 12);
  return { plaintext, prefix };
}

export async function hashApiKey(key: string): Promise<string> {
  return sha256(key);
}

export async function verifyApiKey(key: string, hash: string): Promise<boolean> {
  const computed = await sha256(key);
  return computed === hash;
}