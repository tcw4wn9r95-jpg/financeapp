import Dexie, { type Table } from 'dexie';
import { STORE_NAMES, type StoreName, type StoreRecords, type StoreSnapshot } from '../domain/types';
import { emptySnapshot } from './backup';
import {
  deriveKek,
  deriveKekFromPrf,
  generateRecoveryKey,
  importDataKey,
  normaliseRecoveryKey,
  open,
  openJson,
  PBKDF2_ITERATIONS,
  randomBytes,
  seal,
  sealJson,
  type Sealed,
} from './crypto';

/**
 * Encrypted local store (PRD "Architecture": Storage, Encryption).
 *
 * Physical layout (DECISIONS.md D-03): one IndexedDB database, one table of
 * opaque rows {id, iv, data}. The logical store name and the record itself are
 * inside the ciphertext, so the disk shows neither field values nor how many
 * rows each store holds. On unlock everything is decrypted into memory; the
 * data key is never persisted in clear.
 */

interface EncryptedRow {
  id: string;
  iv: Uint8Array;
  data: Uint8Array;
}

interface WrappedKey {
  salt: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
}

/**
 * A passkey slot (D-44): the data key wrapped under a key derived from the
 * passkey's PRF output for `prfSalt`. Only the credential id and salts are
 * stored; the secret comes from the authenticator after Face ID.
 */
export interface PasskeySlot {
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  wrapped: WrappedKey;
  label: string;
  createdAt: string;
}

interface Keyring {
  id: 'keyring';
  version: 1;
  iterations: number;
  passphrase: WrappedKey;
  recovery: WrappedKey;
  passkeys?: PasskeySlot[];
  createdAt: string;
}

interface Payload<S extends StoreName = StoreName> {
  s: S;
  r: StoreRecords[S];
}

class KassaDb extends Dexie {
  records!: Table<EncryptedRow, string>;
  meta!: Table<Keyring, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ records: '&id', meta: '&id' });
  }
}

export type VaultStatus = 'empty' | 'locked' | 'unlocked';

export class VaultError extends Error {
  constructor(public readonly code: 'badPassphrase' | 'badRecoveryKey' | 'badPasskey' | 'locked' | 'exists' | 'weakPassphrase') {
    super(code);
  }
}

export const MIN_PASSPHRASE_LENGTH = 10;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface VaultOptions {
  dbName?: string;
  /** Lower only in tests. */
  iterations?: number;
}

export type WriteOp =
  | { [S in StoreName]: { type: 'put'; store: S; record: StoreRecords[S] } }[StoreName]
  | { type: 'delete'; store: StoreName; id: string };

export class Vault {
  private db: KassaDb;
  private dek: CryptoKey | null = null;
  private data = new Map<StoreName, Map<string, StoreRecords[StoreName]>>();
  private lists = new Map<StoreName, readonly StoreRecords[StoreName][]>();
  private listeners = new Set<() => void>();
  private _version = 0;
  private _status: VaultStatus = 'locked';
  readonly iterations: number;

  constructor(opts: VaultOptions = {}) {
    this.db = new KassaDb(opts.dbName ?? 'kassa');
    this.iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<VaultStatus> {
    const keyring = await this.db.meta.get('keyring');
    this._status = keyring ? (this.dek ? 'unlocked' : 'locked') : 'empty';
    this.emit();
    return this._status;
  }

  get status(): VaultStatus {
    return this._status;
  }

  get version(): number {
    return this._version;
  }

  /** First run: create the keyring. Returns the recovery key to show the user once. */
  async create(passphrase: string): Promise<string> {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new VaultError('weakPassphrase');
    if (await this.db.meta.get('keyring')) throw new VaultError('exists');
    const raw = randomBytes(32);
    const recoveryKey = generateRecoveryKey();
    const keyring: Keyring = {
      id: 'keyring',
      version: 1,
      iterations: this.iterations,
      passphrase: await this.wrap(raw, passphrase),
      recovery: await this.wrap(raw, recoveryKey),
      createdAt: new Date().toISOString(),
    };
    await this.db.meta.put(keyring);
    this.dek = await importDataKey(raw);
    raw.fill(0);
    this.resetCache();
    this._status = 'unlocked';
    this.emit();
    return recoveryKey;
  }

  async unlock(passphrase: string): Promise<void> {
    const raw = await this.unwrapWith('passphrase', passphrase);
    await this.load(raw);
  }

  /** Unlock with the recovery key, then set a new passphrase. */
  async recover(recoveryKey: string, newPassphrase: string): Promise<void> {
    if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) throw new VaultError('weakPassphrase');
    const raw = await this.unwrapWith('recovery', normaliseRecoveryKey(recoveryKey));
    const keyring = (await this.db.meta.get('keyring'))!;
    await this.db.meta.put({ ...keyring, passphrase: await this.wrap(raw, newPassphrase, keyring.iterations) });
    await this.load(raw);
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    if (next.length < MIN_PASSPHRASE_LENGTH) throw new VaultError('weakPassphrase');
    const raw = await this.unwrapWith('passphrase', current);
    const keyring = (await this.db.meta.get('keyring'))!;
    await this.db.meta.put({ ...keyring, passphrase: await this.wrap(raw, next, keyring.iterations) });
    raw.fill(0);
  }

  // ------------------------------------------------------------- passkeys

  /** Passkeys that can unlock this vault (readable while locked: ids and salts only). */
  async passkeys(): Promise<Pick<PasskeySlot, 'credentialId' | 'prfSalt' | 'label' | 'createdAt'>[]> {
    const keyring = await this.db.meta.get('keyring');
    return (keyring?.passkeys ?? []).map(({ credentialId, prfSalt, label, createdAt }) => ({ credentialId, prfSalt, label, createdAt }));
  }

  /** Add a passkey slot. Needs the passphrase: the data key is never kept in extractable form. */
  async addPasskey(passphrase: string, slot: { credentialId: Uint8Array; prfSalt: Uint8Array; prf: Uint8Array; label: string }): Promise<void> {
    const raw = await this.unwrapWith('passphrase', passphrase);
    try {
      const salt = randomBytes(16);
      const kek = await deriveKekFromPrf(slot.prf, salt);
      const sealed = await seal(kek, raw, 'kassa-dek');
      const keyring = (await this.db.meta.get('keyring'))!;
      const others = (keyring.passkeys ?? []).filter((p) => !sameBytes(p.credentialId, slot.credentialId));
      const record: PasskeySlot = { credentialId: slot.credentialId, prfSalt: slot.prfSalt, wrapped: { salt, ...sealed }, label: slot.label, createdAt: new Date().toISOString() };
      await this.db.meta.put({ ...keyring, passkeys: [...others, record] });
    } finally {
      raw.fill(0);
    }
  }

  async removePasskey(credentialId: Uint8Array): Promise<void> {
    const keyring = await this.db.meta.get('keyring');
    if (!keyring) return;
    await this.db.meta.put({ ...keyring, passkeys: (keyring.passkeys ?? []).filter((p) => !sameBytes(p.credentialId, credentialId)) });
    this.emit();
  }

  /** Unlock with the PRF output the authenticator returned for this credential. */
  async unlockWithPasskey(credentialId: Uint8Array, prf: Uint8Array): Promise<void> {
    const keyring = await this.db.meta.get('keyring');
    const slot = keyring?.passkeys?.find((p) => sameBytes(p.credentialId, credentialId));
    if (!slot) throw new VaultError('badPasskey');
    let raw: Uint8Array;
    try {
      const kek = await deriveKekFromPrf(prf, slot.wrapped.salt);
      raw = await open(kek, { iv: slot.wrapped.iv, data: slot.wrapped.data }, 'kassa-dek');
    } catch {
      throw new VaultError('badPasskey');
    }
    await this.load(raw);
  }

  /** Check a passphrase without changing state (used before exports). */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    try {
      (await this.unwrapWith('passphrase', passphrase)).fill(0);
      return true;
    } catch {
      return false;
    }
  }

  lock(): void {
    this.dek = null;
    this.resetCache();
    if (this._status === 'unlocked') this._status = 'locked';
    this.emit();
  }

  /** Delete the database and everything in it. */
  async destroy(): Promise<void> {
    this.lock();
    await this.db.delete();
    await this.db.open();
    this._status = 'empty';
    this.emit();
  }

  // ---------------------------------------------------------------- reads

  list<S extends StoreName>(store: S): readonly StoreRecords[S][] {
    let l = this.lists.get(store);
    if (!l) {
      l = Object.freeze([...(this.data.get(store)?.values() ?? [])]);
      this.lists.set(store, l);
    }
    return l as readonly StoreRecords[S][];
  }

  get<S extends StoreName>(store: S, id: string): StoreRecords[S] | undefined {
    return this.data.get(store)?.get(id) as StoreRecords[S] | undefined;
  }

  snapshot(): StoreSnapshot {
    const snap = emptySnapshot();
    for (const name of STORE_NAMES) {
      (snap as Record<StoreName, unknown[]>)[name] = [...this.list(name)];
    }
    return structuredClone(snap);
  }

  // --------------------------------------------------------------- writes

  async put<S extends StoreName>(store: S, record: StoreRecords[S]): Promise<void> {
    await this.write([{ type: 'put', store, record } as WriteOp]);
  }

  async remove(store: StoreName, id: string): Promise<void> {
    await this.write([{ type: 'delete', store, id }]);
  }

  /** Apply several writes atomically: all land on disk or none do. */
  async write(ops: readonly WriteOp[]): Promise<void> {
    const dek = this.requireKey();
    const puts: EncryptedRow[] = [];
    const deletes: string[] = [];
    for (const op of ops) {
      if (op.type === 'put') {
        const payload: Payload = { s: op.store, r: op.record };
        const sealed = await sealJson(dek, payload, op.record.id);
        puts.push({ id: op.record.id, ...sealed });
      } else {
        deletes.push(op.id);
      }
    }
    await this.db.transaction('rw', this.db.records, async () => {
      if (deletes.length) await this.db.records.bulkDelete(deletes);
      if (puts.length) await this.db.records.bulkPut(puts);
    });
    for (const op of ops) {
      const map = this.storeMap(op.store);
      if (op.type === 'put') map.set(op.record.id, structuredClone(op.record));
      else map.delete(op.id);
      this.lists.delete(op.store);
    }
    this.emit();
  }

  /** Replace every record (restore). Atomic. */
  async replaceAll(snapshot: StoreSnapshot): Promise<void> {
    const dek = this.requireKey();
    const rows: EncryptedRow[] = [];
    for (const name of STORE_NAMES) {
      for (const record of snapshot[name] as StoreRecords[StoreName][]) {
        const sealed = await sealJson(dek, { s: name, r: record } satisfies Payload, record.id);
        rows.push({ id: record.id, ...sealed });
      }
    }
    await this.db.transaction('rw', this.db.records, async () => {
      await this.db.records.clear();
      await this.db.records.bulkPut(rows);
    });
    this.resetCache();
    for (const name of STORE_NAMES) {
      const map = this.storeMap(name);
      for (const record of snapshot[name] as StoreRecords[StoreName][]) map.set(record.id, structuredClone(record));
    }
    this.emit();
  }

  // ------------------------------------------------------------ subscribe

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this._version;

  // ------------------------------------------------------------- internal

  private emit(): void {
    this._version++;
    for (const l of this.listeners) l();
  }

  private requireKey(): CryptoKey {
    if (!this.dek) throw new VaultError('locked');
    return this.dek;
  }

  private storeMap(store: StoreName): Map<string, StoreRecords[StoreName]> {
    let m = this.data.get(store);
    if (!m) {
      m = new Map();
      this.data.set(store, m);
    }
    return m;
  }

  private resetCache(): void {
    this.data = new Map();
    this.lists = new Map();
  }

  private async wrap(raw: Uint8Array, secret: string, iterations = this.iterations): Promise<WrappedKey> {
    const salt = randomBytes(16);
    const kek = await deriveKek(secret, salt, iterations);
    const sealed = await seal(kek, raw, 'kassa-dek');
    return { salt, ...sealed };
  }

  private async unwrapWith(slot: 'passphrase' | 'recovery', secret: string): Promise<Uint8Array> {
    const keyring = await this.db.meta.get('keyring');
    if (!keyring) throw new VaultError(slot === 'passphrase' ? 'badPassphrase' : 'badRecoveryKey');
    const w = keyring[slot];
    const kek = await deriveKek(secret, w.salt, keyring.iterations);
    try {
      return await open(kek, { iv: w.iv, data: w.data } satisfies Sealed, 'kassa-dek');
    } catch {
      throw new VaultError(slot === 'passphrase' ? 'badPassphrase' : 'badRecoveryKey');
    }
  }

  private async load(raw: Uint8Array): Promise<void> {
    const dek = await importDataKey(raw);
    raw.fill(0);
    const rows = await this.db.records.toArray();
    this.resetCache();
    for (const row of rows) {
      const p = await openJson<Payload>(dek, { iv: row.iv, data: row.data }, row.id);
      this.storeMap(p.s).set(p.r.id, p.r);
    }
    this.dek = dek;
    this._status = 'unlocked';
    this.emit();
  }
}
