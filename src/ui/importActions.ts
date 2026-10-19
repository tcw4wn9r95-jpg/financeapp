import { BUILT_IN_MAPPINGS, type MappingSpec } from '../domain/import/csv';
import type { FileContent } from '../domain/import/detect';
import type { LedgerChanges } from '../domain/import/plan';
import { cleanUpMirrors, type Changes } from '../domain/reconcile';
import { stamp, systemClock } from '../domain/ledger';
import type { BankMapping, Id } from '../domain/types';
import { pdfToLines, type PdfJsLike } from '../infra/pdf';
import { ensureStreamIteration } from '../infra/streams';
import type { Vault, WriteOp } from '../storage/vault';

/** pdf.js is large: load it only when a PDF is imported. */
async function loadPdfJs(mainThread: boolean): Promise<PdfJsLike> {
  ensureStreamIteration();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (mainThread) {
    // Read the PDF on the page itself, without a Web Worker (some phones refuse the worker).
    const g = globalThis as { pdfjsWorker?: unknown };
    if (!g.pdfjsWorker) g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  } else {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return pdfjs as unknown as PdfJsLike;
}

/** A file that could not be read, with the technical reason for the screen. */
export class FileReadError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
  }
}

const nativeStreams = ensureStreamIteration();

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);

export async function readImportFile(file: File): Promise<FileContent> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // By content, not only by name: phones sometimes hand over files without an extension.
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf' || String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
  if (isPdf) {
    let first: unknown = 'not tried';
    // The worker cannot get the stream fix below, so browsers that lack it read on the page (D-60).
    if (nativeStreams) {
      try {
        return { kind: 'pdf', name: file.name, lines: await pdfToLines(await loadPdfJs(false), bytes.slice()) };
      } catch (e) {
        first = e;
      }
    }
    try {
      return { kind: 'pdf', name: file.name, lines: await pdfToLines(await loadPdfJs(true), bytes.slice()) };
    } catch (e) {
      throw new FileReadError(`${describe(e)} (worker: ${describe(first)})`);
    }
  }
  return { kind: 'text', name: file.name, text: new TextDecoder().decode(bytes) };
}

export const parseXml = (xml: string): Document => new DOMParser().parseFromString(xml, 'application/xml');

/** Saved mappings plus built-in layouts not yet saved (ids "builtin:<name>"). */
export function availableMappings(vault: Vault): BankMapping[] {
  const saved = vault.list('bankMappings');
  const builtIns = BUILT_IN_MAPPINGS.filter((b) => !saved.some((s) => s.builtIn && s.name === b.name)).map(
    (b): BankMapping => ({ ...b, id: `builtin:${b.name}`, createdAt: '', updatedAt: '', source: 'manual', lastAccounts: {}, builtIn: true }),
  );
  return [...saved, ...builtIns];
}

/** Store a new mapping, or remember which accounts a mapping's sub-accounts went to. */
export async function saveMapping(vault: Vault, mapping: MappingSpec & Partial<Pick<BankMapping, 'id' | 'builtIn' | 'lastAccounts'>>, lastAccounts?: Record<string, Id>): Promise<BankMapping> {
  const existing = mapping.id && !mapping.id.startsWith('builtin:') ? vault.get('bankMappings', mapping.id) : undefined;
  const record: BankMapping = {
    ...(existing ?? (stamp(systemClock, 'manual') as BankMapping)),
    name: mapping.name,
    headers: mapping.headers,
    delimiter: mapping.delimiter,
    columns: mapping.columns,
    dateFormat: mapping.dateFormat,
    decimal: mapping.decimal,
    okStates: mapping.okStates,
    lastAccounts: { ...(existing?.lastAccounts ?? mapping.lastAccounts ?? {}), ...(lastAccounts ?? {}) },
    ...(mapping.builtIn ? { builtIn: true } : {}),
    updatedAt: new Date().toISOString(),
  };
  await vault.put('bankMappings', record);
  return record;
}

export async function applyImport(vault: Vault, ch: LedgerChanges): Promise<void> {
  const ops: WriteOp[] = [
    ...ch.deleteAllocations.map((id): WriteOp => ({ type: 'delete', store: 'allocations', id })),
    ...ch.transactions.map((record): WriteOp => ({ type: 'put', store: 'transactions', record })),
    ...ch.allocations.map((record): WriteOp => ({ type: 'put', store: 'allocations', record })),
    ...ch.statements.map((record): WriteOp => ({ type: 'put', store: 'statements', record })),
    ...ch.accounts.map((record): WriteOp => ({ type: 'put', store: 'accounts', record })),
    { type: 'put', store: 'importBatches', record: ch.batch },
  ];
  await vault.write(ops);
  await cleanUpLedger(vault);
}

export async function applyChanges(vault: Vault, ch: Changes): Promise<void> {
  const ops: WriteOp[] = [
    ...ch.deleteAllocations.map((id): WriteOp => ({ type: 'delete', store: 'allocations', id })),
    ...ch.deleteTransactions.map((id): WriteOp => ({ type: 'delete', store: 'transactions', id })),
    ...ch.deleteStatements.map((id): WriteOp => ({ type: 'delete', store: 'statements', id })),
    ...ch.deleteBatches.map((id): WriteOp => ({ type: 'delete', store: 'importBatches', id })),
    ...ch.putTransactions.map((record): WriteOp => ({ type: 'put', store: 'transactions', record })),
    ...ch.putAllocations.map((record): WriteOp => ({ type: 'put', store: 'allocations', record })),
    ...ch.putStatements.map((record): WriteOp => ({ type: 'put', store: 'statements', record })),
  ];
  // A record both deleted and re-put in one batch: the put wins.
  const puts = new Set(ops.filter((o) => o.type === 'put').map((o) => (o.type === 'put' ? `${o.store}:${o.record.id}` : '')));
  await vault.write(ops.filter((o) => o.type === 'put' || !puts.has(`${o.store}:${o.id}`)));
}

/**
 * Remove mirrors that duplicate what an account's own statement already shows
 * (D-68). Runs after every import and when the vault is unlocked.
 */
let cleaning: Promise<number> = Promise.resolve(0);
export function cleanUpLedger(vault: Vault): Promise<number> {
  // One at a time: two runs computed on the same data would apply the same fix twice.
  cleaning = cleaning.then(async () => {
    const { changes, fixed } = cleanUpMirrors(ledgerView(vault), systemClock);
    if (fixed > 0) await applyChanges(vault, changes);
    return fixed;
  }, () => 0);
  return cleaning;
}

export function ledgerView(vault: Vault) {
  return {
    accounts: vault.list('accounts'),
    transactions: vault.list('transactions'),
    allocations: vault.list('allocations'),
    statements: vault.list('statements'),
  };
}
