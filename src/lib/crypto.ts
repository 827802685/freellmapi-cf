// Cryptographic utilities for FreeLLMAPI
// Uses Web Crypto API (available in Cloudflare Workers)

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const TAG_LENGTH = 128;
const PBKDF2_ITERATIONS = 100000;
const HASH_ALGO = 'SHA-256';

function getEncryptionKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret.padEnd(32, 'x').slice(0, 32)),
    { name: ALGORITHM },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptAESGCM(plaintext: string, secret: string): Promise<{ data: string; iv: string; tag: string }> {
  const key = await getEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    encoder.encode(plaintext)
  );
  const encryptedArray = new Uint8Array(encrypted);
  const tag = encryptedArray.slice(-16);
  const data = encryptedArray.slice(0, -16);
  return {
    data: bytesToHex(data),
    iv: bytesToHex(iv),
    tag: bytesToHex(tag),
  };
}

export async function decryptAESGCM(data: string, iv: string, tag: string, secret: string): Promise<string> {
  const key = await getEncryptionKey(secret);
  const encryptedData = hexToBytes(data);
  const tagBytes = hexToBytes(tag);
  const combined = new Uint8Array([...encryptedData, ...tagBytes]);
  const ivBytes = hexToBytes(iv);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: ivBytes, tagLength: TAG_LENGTH },
    key,
    combined
  );
  return new TextDecoder().decode(decrypted);
}

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: HASH_ALGO },
    key,
    256
  );
  const saltHex = bytesToHex(salt);
  const hashHex = bytesToHex(new Uint8Array(bits));
  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = hexToBytes(saltHex);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: HASH_ALGO },
    key,
    256
  );
  const computed = bytesToHex(new Uint8Array(bits));
  return computed === hashHex;
}

export async function createJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();
  const headerB64 = base64URLEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64URLEncode(encoder.encode(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })));
  const signature = await crypto.subtle.sign(
    'HMAC-SHA256',
    await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC-SHA256' }, false, ['sign']),
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  const sigB64 = base64URLEncode(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const encoder = new TextEncoder();
  const sig = await crypto.subtle.sign(
    'HMAC-SHA256',
    await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC-SHA256' }, false, ['sign']),
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  const expectedSig = base64URLEncode(new Uint8Array(sig));
  if (sigB64 !== expectedSig) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64URLDecode(payloadB64)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function hashAPIKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest(HASH_ALGO, encoder.encode(key));
  return bytesToHex(new Uint8Array(hash));
}

export function generateAPIKey(prefix: string = 'freellmapi'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${prefix}-${bytesToHex(bytes).slice(0, 24)}`;
}

export function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function base64URLEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64URLDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
}

export function generateChatId(): string {
  return `chatcmpl-${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

export function getTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}