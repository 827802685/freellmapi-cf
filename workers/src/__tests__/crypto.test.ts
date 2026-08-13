/**
 * 加密工具单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  makeKeyHint,
  encryptApiKey,
  randomToken,
  randomHex,
  randomB64Url,
  sha256Hex,
} from '../lib/crypto';

const TEST_HEX_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('encrypt / decrypt', () => {
  it('should encrypt and decrypt a string correctly', async () => {
    const plaintext = 'sk-test-api-key-12345';
    const encrypted = await encrypt(plaintext, TEST_HEX_KEY);
    
    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();
    // IV 应该是 12 字节的 base64
    expect(atob(encrypted.iv).length).toBe(12);

    const decrypted = await decrypt(encrypted, TEST_HEX_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', async () => {
    const plaintext = 'same-text';
    const e1 = await encrypt(plaintext, TEST_HEX_KEY);
    const e2 = await encrypt(plaintext, TEST_HEX_KEY);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
    expect(e1.iv).not.toBe(e2.iv);
  });

  it('should fail to decrypt with wrong key', async () => {
    const plaintext = 'secret-key-data';
    const encrypted = await encrypt(plaintext, TEST_HEX_KEY);
    const wrongKey = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    await expect(decrypt(encrypted, wrongKey)).rejects.toThrow();
  });

  it('should reject invalid hex key length', async () => {
    const shortKey = 'abcd';
    await expect(encrypt('test', shortKey)).rejects.toThrow('must be 32 bytes');
  });
});

describe('hashPassword / verifyPassword', () => {
  it('should hash and verify password correctly', async () => {
    const password = 'my-secure-password-123!';
    const hashed = await hashPassword(password);
    
    expect(hashed.hash).toBeTruthy();
    expect(hashed.salt).toBeTruthy();
    expect(hashed.hash).not.toBe(password);
    expect(hashed.salt).not.toBe(password);

    const valid = await verifyPassword(password, hashed);
    expect(valid).toBe(true);
  });

  it('should reject wrong password', async () => {
    const hashed = await hashPassword('correct-password');
    const valid = await verifyPassword('wrong-password', hashed);
    expect(valid).toBe(false);
  });

  it('should produce different hashes for same password (random salt)', async () => {
    const password = 'same-password';
    const h1 = await hashPassword(password);
    const h2 = await hashPassword(password);
    expect(h1.hash).not.toBe(h2.hash);
    expect(h1.salt).not.toBe(h2.salt);
  });
});

describe('makeKeyHint', () => {
  it('should mask middle part of key', () => {
    const hint = makeKeyHint('gsk_abcdefghijklmnop');
    expect(hint).toBe('gsk_***mnop');
  });

  it('should return *** for short keys', () => {
    expect(makeKeyHint('short')).toBe('***');
  });
});

describe('encryptApiKey', () => {
  it('should return encrypted data and hint', async () => {
    const result = await encryptApiKey('sk-abcdefghijklmnop', TEST_HEX_KEY);
    expect(result.encrypted.ciphertext).toBeTruthy();
    expect(result.hint).toBe('sk-a***mnop');
  });
});

describe('randomToken', () => {
  it('should generate token with prefix', () => {
    const token = randomToken('test-', 16);
    expect(token.startsWith('test-')).toBe(true);
    // base64url 编码,不含 = padding
    expect(token).not.toContain('=');
  });

  it('should generate unique tokens', () => {
    const t1 = randomToken();
    const t2 = randomToken();
    expect(t1).not.toBe(t2);
  });
});

describe('randomHex', () => {
  it('should generate hex string of correct length', () => {
    const hex = randomHex(16);
    expect(hex.length).toBe(32); // 16 bytes = 32 hex chars
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true);
  });
});

describe('randomB64Url', () => {
  it('should generate base64url without padding', () => {
    const b64 = randomB64Url(16);
    expect(b64).not.toContain('=');
    expect(b64).not.toContain('+');
    expect(b64).not.toContain('/');
  });
});

describe('sha256Hex', () => {
  it('should produce correct SHA-256 hash', async () => {
    const hash = await sha256Hex('hello');
    // known SHA-256 of "hello"
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should produce different hashes for different inputs', async () => {
    const h1 = await sha256Hex('input1');
    const h2 = await sha256Hex('input2');
    expect(h1).not.toBe(h2);
  });
});