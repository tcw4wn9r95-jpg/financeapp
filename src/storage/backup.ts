import { STORE_NAMES, type StoreName, type StoreSnapshot } from '../domain/types';
import { deriveKek, fromBase64, openJson, PBKDF2_ITERATIONS, randomBytes, sealJson, sha256Hex, toBase64 } from './crypto';

/**
 * Backup and export formats (PRD F12).
 *
 * - Full JSON export: plaintext, human-readable, every store.
 * - Encrypted backup: the same JSON sealed with AES-GCM under a key derived
 *   from a backup passphrase (PBKDF2, fresh salt per file).
 *
 * Both carry a SHA-256 of the canonical data so a restore can prove that all
 * data came back identical.
 */

export const SCHEMA_VERSION = 1;

export interface PlainExport {
  format: 'kassa-export';
  schemaVersion: number;
  exportedAt: string;
  hash: string;
  stores: StoreSnapshot;
}

export interface EncryptedBackup {
  format: 'kassa-backup';
  version: 1;
  createdAt: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  ciphertext: string;
}

export class BackupError extends Error {
  constructor(public readonly code: 'notBackup' | 'badPassphrase' | 'hashMismatch' | 'newerSchema') {
    super(code);
  }
}

export function emptySnapshot(): StoreSnapshot {
  return Object.fromEntries(STORE_NAMES.map((n) => [n, []])) as unknown as StoreSnapshot;
}

/**
 * JSON with object keys sorted and each store sorted by id: same data, same
 * text. `names` limits it to some stores, so a file written by an older
 * version (with fewer stores) still verifies against its own hash.
 */
export function canonicalJson(snapshot: StoreSnapshot, names: readonly StoreName[] = STORE_NAMES): string {
  const sorted: Record<string, unknown[]> = {};
  for (const name of [...names].sort()) {
    const rows = [...((snapshot[name] ?? []) as { id: string }[])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    sorted[name] = rows;
  }
  return JSON.stringify(sorted, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export async function snapshotHash(snapshot: StoreSnapshot, names?: readonly StoreName[]): Promise<string> {
  return sha256Hex(canonicalJson(snapshot, names));
}

export async function toPlainExport(snapshot: StoreSnapshot, now = new Date()): Promise<PlainExport> {
  return {
    format: 'kassa-export',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    hash: await snapshotHash(snapshot),
    stores: snapshot,
  };
}

/** Validate a parsed export and normalise missing stores to empty arrays. */
export async function readPlainExport(value: unknown): Promise<PlainExport> {
  const v = value as Partial<PlainExport> | null;
  if (!v || v.format !== 'kassa-export' || typeof v.stores !== 'object' || !v.stores) {
    throw new BackupError('notBackup');
  }
  if ((v.schemaVersion ?? 0) > SCHEMA_VERSION) throw new BackupError('newerSchema');
  const stores = emptySnapshot();
  for (const name of STORE_NAMES) {
    const rows = (v.stores as Partial<Record<StoreName, unknown>>)[name];
    if (rows !== undefined && !Array.isArray(rows)) throw new BackupError('notBackup');
    (stores as Record<StoreName, unknown[]>)[name] = structuredClone((rows as unknown[] | undefined) ?? []);
  }
  // Verify against the stores the file itself contains (older versions had fewer).
  const present = STORE_NAMES.filter((n) => n in (v.stores as object));
  if (v.hash && v.hash !== (await snapshotHash(stores, present))) throw new BackupError('hashMismatch');
  const hash = await snapshotHash(stores);
  return { format: 'kassa-export', schemaVersion: v.schemaVersion ?? SCHEMA_VERSION, exportedAt: v.exportedAt ?? '', hash, stores };
}

export async function encryptBackup(
  plain: PlainExport,
  passphrase: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<EncryptedBackup> {
  const salt = randomBytes(16);
  const key = await deriveKek(passphrase, salt, iterations);
  const sealed = await sealJson(key, plain, 'kassa-backup-v1');
  return {
    format: 'kassa-backup',
    version: 1,
    createdAt: plain.exportedAt,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(sealed.iv) },
    ciphertext: toBase64(sealed.data),
  };
}

export function isEncryptedBackup(value: unknown): value is EncryptedBackup {
  const v = value as Partial<EncryptedBackup> | null;
  return !!v && v.format === 'kassa-backup' && typeof v.ciphertext === 'string' && !!v.kdf && !!v.cipher;
}

export async function decryptBackup(backup: EncryptedBackup, passphrase: string): Promise<PlainExport> {
  if (!isEncryptedBackup(backup)) throw new BackupError('notBackup');
  const key = await deriveKek(passphrase, fromBase64(backup.kdf.salt), backup.kdf.iterations);
  let plain: unknown;
  try {
    plain = await openJson(key, { iv: fromBase64(backup.cipher.iv), data: fromBase64(backup.ciphertext) }, 'kassa-backup-v1');
  } catch {
    throw new BackupError('badPassphrase');
  }
  return readPlainExport(plain);
}
