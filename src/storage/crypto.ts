/**
 * WebCrypto primitives. AES-GCM 256 for records; PBKDF2-SHA-256 (600,000
 * iterations by default) to turn a passphrase into a key-encryption key.
 *
 * Key hierarchy (DECISIONS.md D-04):
 *   passphrase ──PBKDF2──▶ KEK₁ ─┐
 *                                 ├─ each wraps the same random data key (DEK)
 *   recovery key ─PBKDF2─▶ KEK₂ ─┘
 * Only the DEK encrypts records. It lives in memory while unlocked.
 */

export const PBKDF2_ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Sealed {
  iv: Uint8Array;
  data: Uint8Array;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects SharedArrayBuffer views). */
function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
}

export async function deriveKek(secret: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(secret.normalize('NFC')), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Key-encryption key from a passkey's PRF output (WebAuthn "prf" extension):
 * 32 secret bytes the authenticator releases only after Face ID / Touch ID.
 * PRF output is already uniformly random, so HKDF is enough (no stretching).
 */
export async function deriveKekFromPrf(prf: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', buf(prf), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: enc.encode('kassa-passkey-kek') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function importDataKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, plaintext: Uint8Array, aad?: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), ...(aad ? { additionalData: enc.encode(aad) } : {}) },
    key,
    buf(plaintext),
  );
  return { iv, data: new Uint8Array(data) };
}

/** Throws (OperationError) when the key is wrong or the data was tampered with. */
export async function open(key: CryptoKey, sealed: Sealed, aad?: string): Promise<Uint8Array> {
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(sealed.iv), ...(aad ? { additionalData: enc.encode(aad) } : {}) },
    key,
    buf(sealed.data),
  );
  return new Uint8Array(data);
}

export async function sealJson(key: CryptoKey, value: unknown, aad?: string): Promise<Sealed> {
  return seal(key, enc.encode(JSON.stringify(value)), aad);
}

export async function openJson<T>(key: CryptoKey, sealed: Sealed, aad?: string): Promise<T> {
  return JSON.parse(dec.decode(await open(key, sealed, aad))) as T;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** 24 random symbols from a 32-letter alphabet = 120 bits, shown as 6 groups of 4. */
export function generateRecoveryKey(): string {
  const bytes = randomBytes(24);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % 32]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** Accepts the recovery key with any spacing, dashes or case. */
export function normaliseRecoveryKey(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.match(/.{1,4}/g)?.join('-') ?? '';
}
