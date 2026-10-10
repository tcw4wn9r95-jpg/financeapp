import { BUILT_IN_MAPPINGS, type MappingSpec } from '../domain/import/csv';
import type { FileContent } from '../domain/import/detect';
import type { LedgerChanges } from '../domain/import/plan';
import type { Changes } from '../domain/reconcile';
import { stamp, systemClock } from '../domain/ledger';
import type { BankMapping, Id } from '../domain/types';
import { pdfToLines, type PdfJsLike } from '../infra/pdf';
import type { Vault, WriteOp } from '../storage/vault';

/** pdf.js is large: load it only when a PDF is imported. */
async function loadPdfJs(): Promise<PdfJsLike> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs as unknown as PdfJsLike;
}

export async function readImportFile(file: File): Promise<FileContent> {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const pdfjs = await loadPdfJs();
    return { kind: 'pdf', name: file.name, lines: await pdfToLines(pdfjs, new Uint8Array(await file.arrayBuffer())) };
  }
  return { kind: 'text', name: file.name, text: await file.text() };
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

export function ledgerView(vault: Vault) {
  return {
    accounts: vault.list('accounts'),
    transactions: vault.list('transactions'),
    allocations: vault.list('allocations'),
    statements: vault.list('statements'),
  };
}
