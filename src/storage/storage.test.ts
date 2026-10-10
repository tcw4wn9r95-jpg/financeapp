import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Account, StoreSnapshot } from '../domain/types';
import { BackupError, canonicalJson, decryptBackup, emptySnapshot, encryptBackup, readPlainExport, snapshotHash, toPlainExport } from './backup';
import { deriveKek, generateRecoveryKey, normaliseRecoveryKey, openJson, sealJson } from './crypto';
import { Vault, VaultError } from './vault';

const FAST = 1_000; // PBKDF2 iterations in tests; production uses 600,000.
let dbCounter = 0;
const newVault = () => new Vault({ dbName: `test-${++dbCounter}`, iterations: FAST });

const account = (id: string, name = id): Account => ({
  id, name, type: 'current', institution: 'Spuerkeess', ibanLast4: '1234', openingBalance: 123456,
  createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', source: 'manual',
});

describe('crypto', () => {
  it('round-trips JSON and rejects the wrong key', async () => {
    const salt = new Uint8Array(16);
    const k1 = await deriveKek('correct horse battery', salt, FAST);
    const k2 = await deriveKek('wrong horse battery', salt, FAST);
    const sealed = await sealJson(k1, { a: 1 }, 'aad');
    expect(await openJson(k1, sealed, 'aad')).toEqual({ a: 1 });
    await expect(openJson(k2, sealed, 'aad')).rejects.toThrow();
    await expect(openJson(k1, sealed, 'other-aad')).rejects.toThrow();
  });

  it('generates readable 120-bit recovery keys', () => {
    const k = generateRecoveryKey();
    expect(k).toMatch(/^([A-HJ-NP-Z2-9]{4}-){5}[A-HJ-NP-Z2-9]{4}$/);
    expect(normaliseRecoveryKey(k.toLowerCase().replace(/-/g, ' '))).toBe(k);
  });
});

describe('Vault', () => {
  it('stores records encrypted and reloads them after unlock', async () => {
    const v = newVault();
    expect(await v.init()).toBe('empty');
    const recovery = await v.create('a long passphrase');
    expect(v.status).toBe('unlocked');
    await v.put('accounts', account('a1', 'Spuerkeess current'));
    expect(v.list('accounts')).toHaveLength(1);

    // Nothing readable on disk.
    const raw = await (v as unknown as { db: { records: { toArray(): Promise<unknown[]> } } }).db.records.toArray();
    expect(JSON.stringify(raw)).not.toContain('Spuerkeess');
    expect(JSON.stringify(raw)).not.toContain('accounts');

    v.lock();
    expect(v.list('accounts')).toHaveLength(0);
    await expect(v.put('accounts', account('a2'))).rejects.toEqual(new VaultError('locked'));
    await expect(v.unlock('not the passphrase')).rejects.toEqual(new VaultError('badPassphrase'));
    await v.unlock('a long passphrase');
    expect(v.get('accounts', 'a1')!.name).toBe('Spuerkeess current');

    // Recovery key resets the passphrase.
    v.lock();
    await v.recover(recovery.toLowerCase(), 'a brand new passphrase');
    v.lock();
    await expect(v.unlock('a long passphrase')).rejects.toEqual(new VaultError('badPassphrase'));
    await v.unlock('a brand new passphrase');
    expect(v.list('accounts')).toHaveLength(1);
  });

  it('rejects short passphrases and a second create', async () => {
    const v = newVault();
    await v.init();
    await expect(v.create('short')).rejects.toEqual(new VaultError('weakPassphrase'));
    await v.create('long enough passphrase');
    await expect(v.create('long enough passphrase')).rejects.toEqual(new VaultError('exists'));
  });

  it('changes the passphrase without touching data', async () => {
    const v = newVault();
    await v.init();
    await v.create('first passphrase!');
    await v.put('accounts', account('a1'));
    await expect(v.changePassphrase('wrong one!!', 'second passphrase')).rejects.toEqual(new VaultError('badPassphrase'));
    await v.changePassphrase('first passphrase!', 'second passphrase');
    v.lock();
    await v.unlock('second passphrase');
    expect(v.list('accounts')).toHaveLength(1);
  });

  it('applies batched writes and deletes', async () => {
    const v = newVault();
    await v.init();
    await v.create('passphrase 1234');
    await v.write([
      { type: 'put', store: 'accounts', record: account('a1') },
      { type: 'put', store: 'accounts', record: account('a2') },
    ]);
    await v.write([{ type: 'delete', store: 'accounts', id: 'a1' }]);
    v.lock();
    await v.unlock('passphrase 1234');
    expect(v.list('accounts').map((a) => a.id)).toEqual(['a2']);
  });

  it('notifies subscribers and keeps list references stable between writes', async () => {
    const v = newVault();
    await v.init();
    await v.create('passphrase 1234');
    let calls = 0;
    const off = v.subscribe(() => calls++);
    const before = v.list('accounts');
    expect(v.list('accounts')).toBe(before);
    await v.put('accounts', account('a1'));
    expect(v.list('accounts')).not.toBe(before);
    expect(calls).toBe(1);
    off();
  });
});

describe('F12 backup and restore', () => {
  const sample = (): StoreSnapshot => {
    const s = emptySnapshot();
    s.accounts.push(account('b'), account('a'));
    s.settings.push({ id: 'settings', budgetStartMonth: '2026-04', autoLockMinutes: 15, updatedAt: '2026-10-10T00:00:00.000Z' });
    return s;
  };

  it('canonical JSON ignores row and key order', async () => {
    const a = sample();
    const b = sample();
    b.accounts.reverse();
    b.accounts[0] = Object.fromEntries(Object.entries(b.accounts[0]!).reverse()) as unknown as Account;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await snapshotHash(a)).toBe(await snapshotHash(b));
  });

  it('encrypted backup restores identical data (hash check) after clearing the browser', async () => {
    const v1 = newVault();
    await v1.init();
    await v1.create('household passphrase');
    await v1.replaceAll(sample());
    const before = await snapshotHash(v1.snapshot());
    const file = JSON.stringify(await encryptBackup(await toPlainExport(v1.snapshot()), 'backup passphrase', FAST));
    expect(file).not.toContain('Spuerkeess');
    await v1.destroy(); // "clear the browser"

    const v2 = newVault();
    await v2.init();
    await v2.create('a new device passphrase');
    await expect(decryptBackup(JSON.parse(file), 'wrong passphrase')).rejects.toEqual(new BackupError('badPassphrase'));
    const restored = await decryptBackup(JSON.parse(file), 'backup passphrase');
    await v2.replaceAll(restored.stores);
    v2.lock();
    await v2.unlock('a new device passphrase');
    expect(await snapshotHash(v2.snapshot())).toBe(before);
    expect(restored.hash).toBe(before);
  });

  it('detects a tampered plain export', async () => {
    const exp = await toPlainExport(sample());
    exp.stores.accounts[0]!.openingBalance = 1;
    await expect(readPlainExport(JSON.parse(JSON.stringify(exp)))).rejects.toEqual(new BackupError('hashMismatch'));
  });

  it('rejects files that are not Kassa exports', async () => {
    await expect(readPlainExport({ hello: 'world' })).rejects.toEqual(new BackupError('notBackup'));
  });
});

describe('backups from older versions', () => {
  it('a backup written before new stores existed still verifies and restores', async () => {
    const s = emptySnapshot();
    s.accounts.push(account('a'));
    const oldStores = Object.fromEntries(Object.entries(s).filter(([k]) => !['statements', 'importBatches', 'bankMappings'].includes(k)));
    const oldHash = await snapshotHash(s, Object.keys(oldStores) as never);
    const restored = await readPlainExport({ format: 'kassa-export', schemaVersion: 1, exportedAt: '', hash: oldHash, stores: oldStores });
    expect(restored.stores.statements).toEqual([]);
    expect(restored.stores.accounts).toHaveLength(1);
    expect(restored.hash).toBe(await snapshotHash(restored.stores));
  });
});
