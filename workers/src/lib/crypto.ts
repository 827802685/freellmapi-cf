/**
 * 加密工具
 * - AES-256-GCM 加密 API key
 * - scrypt 哈希密码
 * - 全部使用 Web Crypto API(Workers 原生)
 */

// ============= AES-256-GCM =============

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importEncryptionKey(hexKey: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(hexKey);
  if (keyBytes.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${keyBytes.length}`);
  }
  return crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export interface EncryptedData {
  ciphertext: string;  // base64
  iv: string;          // base64
  tag: string;         // base64 (GCM auth tag 包含在密文末尾,这里单独存以便管理)
}

/**
 * 加密字符串
 */
export async function encrypt(plaintext: string, hexKey: string): Promise<EncryptedData> {
  const key = await importEncryptionKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
    key,
    encoded as BufferSource
  );

  // GCM 模式下,加密结果末尾 16 字节是 auth tag
  const cipherBytes = new Uint8Array(cipherBuffer);
  const tag = cipherBytes.slice(cipherBytes.length - 16);
  const ciphertext = cipherBytes.slice(0, cipherBytes.length - 16);

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
  };
}

/**
 * 解密字符串
 */
export async function decrypt(data: EncryptedData, hexKey: string): Promise<string> {
  const key = await importEncryptionKey(hexKey);
  const iv = base64ToBytes(data.iv);
  const tag = base64ToBytes(data.tag);
  const ciphertext = base64ToBytes(data.ciphertext);

  // 重组: ciphertext + tag
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
    key,
    combined as BufferSource
  );

  return new TextDecoder().decode(plainBuffer);
}

/**
 * 生成 key 提示(脱敏展示)
 * 例如 "gsk_abcdefghijklmnop" -> "gsk_***mnop"
 */
export function makeKeyHint(plaintext: string): string {
  if (plaintext.length <= 8) return '***';
  const prefix = plaintext.slice(0, 4);
  const suffix = plaintext.slice(-4);
  return `${prefix}***${suffix}`;
}

/**
 * 加密 API key 并返回密文 + hint
 */
export async function encryptApiKey(
  plaintext: string,
  hexKey: string
): Promise<{ encrypted: EncryptedData; hint: string }> {
  const encrypted = await encrypt(plaintext, hexKey);
  return { encrypted, hint: makeKeyHint(plaintext) };
}

// ============= scrypt 密码哈希 =============
// Workers 没有原生 scrypt,用 PBKDF2 替代(Web Crypto 支持)

export interface HashedPassword {
  hash: string;  // base64
  salt: string;  // base64
}

async function pbkdf2(password: string, saltBytes: Uint8Array, iterations = 100000): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<HashedPassword> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { hash: bytesToBase64(hash), salt: bytesToBase64(salt) };
}

export async function verifyPassword(
  password: string,
  stored: HashedPassword
): Promise<boolean> {
  const saltBytes = base64ToBytes(stored.salt);
  const expected = base64ToBytes(stored.hash);
  const actual = await pbkdf2(password, saltBytes);

  // 常时比较(防 timing attack)
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected[i] ^ actual[i];
  }
  return diff === 0;
}

// ============= 随机 token 生成 =============

export function randomToken(prefix = 'freellmapi-', length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // base64url 编码
  const b64 = bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return prefix + b64;
}

export function randomHex(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomB64Url(length = 32): string {
  return randomToken('', length);
}

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input) as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
