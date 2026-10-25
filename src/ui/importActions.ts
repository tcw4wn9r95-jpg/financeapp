import { BUILT_IN_MAPPINGS, type MappingSpec } from '../domain/import/csv';
import type { FileContent } from '../domain/import/detect';
import type { LedgerChanges } from '../domain/import/plan';
import { cleanUpMirrors, fileSuggestedTransfers, linkLoanPayments, pairOpenTransfers, repairWeakPairs, settleGroupedTransfers, type Changes } from '../domain/reconcile';
import { stamp, systemClock } from '../domain/ledger';
import type { BankMapping, Id } from '../domain/types';
import { pdfToLines, type PdfJsLike } from '../infra/pdf';
import { ensureStreamIteration } from '../infra/streams';
import type { Vault, WriteOp } from '../storage/vault';
import { t } from '../i18n';

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
export interface CleanUpResult {
  mirrors: number;
  paired: number;
  /** Rows sent back to the inbox because their automatic pairing looked wrong. */
  reopened: number;
  /** Loan payments filed to the loan's line that now also lower the loan (D-93). */
  loans: number;
}
let cleaning: Promise<CleanUpResult> = Promise.resolve({ mirrors: 0, paired: 0, reopened: 0, loans: 0 });
/**
 * Remove mirrors that duplicate what an account's own statement already shows
 * (D-68), then pair the transfers between own accounts still in the inbox
 * (D-71). Runs after every import, when the vault is unlocked and after a restore.
 */
export function cleanUpLedger(vault: Vault): Promise<CleanUpResult> {
  // One at a time: two runs computed on the same data would apply the same fix twice.
  cleaning = cleaning.then(
    async () => {
      const m = cleanUpMirrors(ledgerView(vault), systemClock);
      if (m.fixed > 0) await applyChanges(vault, m.changes);
      const w = repairWeakPairs(ledgerView(vault), systemClock);
      if (w.reopened > 0) await applyChanges(vault, w.changes);
      const p = pairOpenTransfers(ledgerView(vault), systemClock);
      if (p.paired > 0) await applyChanges(vault, p.changes);
      const g = settleGroupedTransfers(ledgerView(vault), systemClock);
      if (g.settled > 0) await applyChanges(vault, g.changes);
      const f = fileSuggestedTransfers(ledgerView(vault), systemClock);
      if (f.filed > 0) await applyChanges(vault, f.changes);
      // A payment filed to a loan's line also lowers the loan (D-93).
      const l = linkLoanPayments(ledgerView(vault), systemClock);
      if (l.linked > 0) await applyChanges(vault, l.changes);
      return { mirrors: m.fixed, paired: p.paired + g.settled + f.filed, reopened: w.reopened, loans: l.linked };
    },
    () => ({ mirrors: 0, paired: 0, reopened: 0, loans: 0 }),
  );
  return cleaning;
}

/** One message for what the clean-up did, or nothing. */
export function cleanUpMessage(r: CleanUpResult): string | undefined {
  const parts = [
    r.paired === 1 ? t('ledger.transferPairedOne') : r.paired > 1 ? t('ledger.transfersPaired', { n: r.paired }) : '',
    r.reopened > 0 ? t('ledger.pairsUndone', { n: r.reopened }) : '',
    r.mirrors === 1 ? t('ledger.mirrorCleanedOne') : r.mirrors > 1 ? t('ledger.mirrorsCleaned', { n: r.mirrors }) : '',
    r.loans > 0 ? t('ledger.loansLinked', { n: r.loans }) : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

export function ledgerView(vault: Vault) {
  return {
    accounts: vault.list('accounts'),
    transactions: vault.list('transactions'),
    allocations: vault.list('allocations'),
    statements: vault.list('statements'),
  };
}
