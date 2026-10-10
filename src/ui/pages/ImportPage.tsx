import { useState, type FormEvent } from 'react';
import { formatDate } from '../../domain/dates';
import { guessColumns, parseCsv, type MappingSpec } from '../../domain/import/csv';
import { detectAndParse, type FileContent } from '../../domain/import/detect';
import { assignAccounts, planImport, subAccounts } from '../../domain/import/plan';
import { ImportParseError, type ParseResult } from '../../domain/import/types';
import { systemClock } from '../../domain/ledger';
import type { BankMapping, Id, ImportReport } from '../../domain/types';
import { t, type MessageKey } from '../../i18n';
import { getSettings } from '../actions';
import { SelectField, TextField } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useStore, useVault } from '../hooks';
import { learnContext, writeLearn } from '../learnActions';
import { learnOnImport } from '../../domain/learn';
import { applyImport, availableMappings, ledgerView, parseXml, readImportFile, saveMapping } from '../importActions';
import { accountTypeLabel } from '../labels';
import { href } from '../router';
import { AccountDialog } from './AccountsPage';

type Item =
  | { id: number; file: File; state: 'reading' }
  | { id: number; file: File; state: 'error'; message: string }
  | { id: number; file: File; state: 'mapping'; content: FileContent; header: string[]; sample: string[][] }
  | { id: number; file: File; state: 'ready'; content: FileContent; result: ParseResult; mapping?: BankMapping; choice: Record<string, Id> }
  | { id: number; file: File; state: 'done'; report: ImportReport; accountIds: Id[] };

let nextId = 1;

export function ImportPage() {
  useDocumentTitle(t('nav.import'));
  const vault = useVault();
  const [items, setItems] = useState<Item[]>([]);
  const update = (id: number, next: Item) => setItems((xs) => xs.map((x) => (x.id === id ? next : x)));

  function parseItem(id: number, file: File, content: FileContent) {
    try {
      const d = detectAndParse(content, availableMappings(vault), parseXml);
      if (d.kind === 'needsMapping') {
        update(id, { id, file, state: 'mapping', content, header: d.header, sample: d.sample });
        return;
      }
      const accounts = vault.list('accounts');
      const subs = subAccounts(d.result, accounts, d.mapping?.lastAccounts);
      const choice = Object.fromEntries(subs.filter((s) => s.accountId).map((s) => [s.key, s.accountId!]));
      update(id, { id, file, state: 'ready', content, result: d.result, ...(d.mapping ? { mapping: d.mapping } : {}), choice });
    } catch (e) {
      update(id, { id, file, state: 'error', message: parseErrorText(e) });
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const added = Array.from(files).map((file): Item => ({ id: nextId++, file, state: 'reading' }));
    setItems((xs) => [...added, ...xs]);
    for (const item of added) {
      try {
        const content = await readImportFile(item.file);
        parseItem(item.id, item.file, content);
      } catch {
        update(item.id, { id: item.id, file: item.file, state: 'error', message: t('import.error.unreadable') });
      }
    }
  }

  return (
    <>
      <h1>{t('nav.import')}</h1>
      <p>{t('import.intro')}</p>
      <div className="card">
        <div className="field">
          <label htmlFor="import-files">{t('import.choose')}</label>
          <input id="import-files" type="file" multiple accept=".csv,.txt,.xml,.pdf,text/csv,application/pdf,application/xml" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          <p className="hint">{t('import.formats')}</p>
        </div>
      </div>
      {items.map((item) => (
        <section key={item.id} className="card" aria-labelledby={`imp-${item.id}`}>
          <h2 id={`imp-${item.id}`} className="file-name">{item.file.name}</h2>
          {item.state === 'reading' && <p role="status">{t('import.reading')}</p>}
          {item.state === 'error' && <p className="error" role="alert">⚠ {item.message}</p>}
          {item.state === 'mapping' && (
            <MappingEditor header={item.header} sample={item.sample} text={item.content.kind === 'text' ? item.content.text : ''} onSaved={() => parseItem(item.id, item.file, item.content)} />
          )}
          {item.state === 'ready' && (
            <ReadyItem
              item={item}
              onChoice={(choice) => update(item.id, { ...item, choice })}
              onDone={(report, accountIds, choice) =>
                setItems((xs) =>
                  xs.map((x) => {
                    if (x.id === item.id) return { id: item.id, file: item.file, state: 'done', report, accountIds };
                    // Other files of the same layout waiting to be imported get the same accounts.
                    if (x.state === 'ready' && item.mapping && x.mapping?.name === item.mapping.name) {
                      const filled = { ...x.choice };
                      for (const [k, v] of Object.entries(choice)) if (filled[k] === undefined && v) filled[k] = v;
                      return { ...x, choice: filled };
                    }
                    return x;
                  }),
                )
              }
            />
          )}
          {item.state === 'done' && <Report report={item.report} />}
        </section>
      ))}
      <SavedMappings />
    </>
  );
}

function parseErrorText(e: unknown): string {
  if (e instanceof ImportParseError) {
    const key = `import.error.${e.code}` as MessageKey;
    return t(key, { detail: e.detail });
  }
  return t('import.error.unreadable');
}

function ReadyItem({ item, onChoice, onDone }: {
  item: Extract<Item, { state: 'ready' }>;
  onChoice: (c: Record<string, Id>) => void;
  onDone: (r: ImportReport, accountIds: Id[], choice: Record<string, Id>) => void;
}) {
  const vault = useVault();
  const notify = useToast();
  const accounts = useStore('accounts');
  const [busy, setBusy] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const { result, choice } = item;
  const subs = subAccounts(result, accounts);
  const anyAccount = subs.some((s) => choice[s.key]);
  const allDecided = subs.every((s) => choice[s.key] !== undefined);
  const dates = result.rows.map((r) => r.date).sort();

  async function run() {
    setBusy(true);
    try {
      const assigned = assignAccounts(result, Object.fromEntries(Object.entries(choice).filter(([, v]) => v)));
      const planned = planImport(
        {
          fileName: item.file.name,
          format: result.format,
          ...(item.mapping && !item.mapping.id.startsWith('builtin:') ? { mappingId: item.mapping.id } : {}),
          ...assigned,
          warnings: result.warnings,
          budgetStartMonth: getSettings(vault).budgetStartMonth,
        },
        ledgerView(vault),
        systemClock,
      );
      // Rules and past decisions classify what they recognise (M4).
      const learned = learnOnImport(planned, learnContext(vault), systemClock);
      const ch = learned.changes;
      if (item.mapping) {
        const saved = await saveMapping(vault, item.mapping, Object.fromEntries(Object.entries(choice).filter(([, v]) => v)));
        ch.batch.mappingId = saved.id;
      }
      await applyImport(vault, ch);
      if (learned.rules.length) await writeLearn(vault, { transactions: [], allocations: [], rules: learned.rules, applied: 0, suggested: 0 });
      notify(t('import.done', { n: ch.batch.report.newCount }));
      onDone(ch.batch.report, ch.batch.accountIds, choice);
    } catch {
      notify(t('common.unexpectedError'), 'error');
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        <strong>{result.label}</strong> · {t('import.rows', { n: result.rows.length })}
        {dates.length > 0 && ` · ${formatDate(dates[0]!)} – ${formatDate(dates.at(-1)!)}`}
        {result.skipped.length > 0 && ` · ${t('import.willSkip', { n: result.skipped.length })}`}
      </p>
      {result.warnings.map((w) => <Warning key={w} code={w} />)}
      <table className="table">
        <caption className="visually-hidden">{t('import.subAccounts')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('import.inFile')}</th>
            <th scope="col">{t('import.balances')}</th>
            <th scope="col">{t('import.toAccount')}</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => {
            const st = result.statements.find((x) => x.accountKey === s.key);
            return (
              <tr key={s.key}>
                <th scope="row">
                  {s.key === 'main' ? t('import.wholeFile') : s.last4 ? `••${s.last4}` : s.key}
                  <span className="cat-meta">{t('import.rows', { n: s.rows })}</span>
                </th>
                <td>
                  {st?.openingBalance !== undefined && <span className="cat-meta">{t('import.opening')} <Money cents={st.openingBalance} /></span>}
                  {st?.closingBalance !== undefined && <span className="cat-meta">{t('import.closing')} <Money cents={st.closingBalance} /></span>}
                  {st?.settlement && <span className="cat-meta">{t('import.settlement', { date: formatDate(st.settlement.date) })} <Money cents={st.settlement.amount} /></span>}
                </td>
                <td>
                  <label className="visually-hidden" htmlFor={`acc-${item.id}-${s.key}`}>{t('import.toAccountFor', { key: s.key })}</label>
                  <select
                    id={`acc-${item.id}-${s.key}`}
                    value={choice[s.key] ?? '__unset'}
                    aria-invalid={choice[s.key] === undefined}
                    onChange={(e) => {
                      if (e.target.value === '__new') setCreatingFor(s.key);
                      else onChoice({ ...choice, [s.key]: e.target.value });
                    }}
                  >
                    {choice[s.key] === undefined && <option value="__unset" disabled>{t('common.choose')}</option>}
                    <option value="">{t('import.skipSub')}</option>
                    {accounts.filter((a) => !a.closedAt).map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({accountTypeLabel(a.type)}{a.ibanLast4 ? ` ••${a.ibanLast4}` : ''})</option>
                    ))}
                    <option value="__new">+ {t('import.newAccount')}</option>
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="button button-primary" disabled={busy || !anyAccount || !allDecided} onClick={() => void run()}>
          {busy ? t('lock.working') : t('import.run')}
        </button>
        {(!anyAccount || !allDecided) && <span className="hint">{t('import.pickAccount')}</span>}
      </div>
      {creatingFor !== null && (
        <AccountDialog
          existing={undefined}
          initial={{
            type: result.format === 'pdf-worldline' ? 'card' : creatingFor === 'Deposit' ? 'savings' : 'current',
            ibanLast4: subs.find((s) => s.key === creatingFor)?.last4 ?? '',
            institution: result.format === 'pdf-spuerkeess' ? 'Spuerkeess' : result.format === 'pdf-worldline' ? 'Worldline' : result.label === 'Revolut' ? 'Revolut' : '',
          }}
          onClose={(createdId) => {
            if (createdId) onChoice({ ...choice, [creatingFor]: createdId });
            setCreatingFor(null);
          }}
        />
      )}
    </>
  );
}

function Warning({ code }: { code: string }) {
  const [kind, a, b] = code.split(':');
  const accounts = useStore('accounts');
  let text: string;
  switch (kind) {
    case 'balanceMismatch':
    case 'totalMismatch':
      text = t('import.warn.balanceMismatch');
      break;
    case 'balanceGap':
      text = t('import.warn.balanceGap', { line: b ?? '?' });
      break;
    case 'beforeStart':
      text = t('import.warn.beforeStart', { n: a ?? '?' });
      break;
    case 'openingSet':
      return (
        <p className="notice">
          ✓ {t('import.warn.openingSet', { name: accounts.find((x) => x.id === a)?.name ?? '?' })} <Money cents={Number(b)} />
        </p>
      );
    default:
      text = code;
  }
  return <p className="notice notice-warn">⚠ {text}{kind === 'beforeStart' && <> <a href={href('settings')}>{t('nav.settings')}</a></>}</p>;
}

const SKIP_KEYS: Record<string, MessageKey> = {
  reverted: 'import.skip.reverted',
  pending: 'import.skip.pending',
  declined: 'import.skip.declined',
  state: 'import.skip.state',
  currency: 'import.skip.currency',
  unparseable: 'import.skip.unparseable',
  zero: 'import.skip.zero',
  locked: 'import.skip.locked',
  ignored: 'import.skip.ignored',
};

export function Report({ report }: { report: ImportReport }) {
  const inboxCount = report.newCount + report.suggestions;
  return (
    <div className="report" role="status">
      <h3>{t('import.report')}</h3>
      <ul className="plain-list">
        <li className="split-row"><span>{t('import.r.new')}</span><strong>{report.newCount}</strong></li>
        <li className="split-row"><span>{t('import.r.duplicates')}</span><strong>{report.duplicateCount}</strong></li>
        <li className="split-row"><span>{t('import.r.skipped')}</span><strong>{report.skipped.length}</strong></li>
        <li className="split-row"><span>{t('import.r.paired')}</span><strong>{report.transfersPaired}</strong></li>
        <li className="split-row"><span>{t('import.r.mirrors')}</span><strong>{report.mirrorsCreated}</strong></li>
        {report.mirrorsReplaced > 0 && <li className="split-row"><span>{t('import.r.replaced')}</span><strong>{report.mirrorsReplaced}</strong></li>}
        {report.cardSettlementsLinked > 0 && <li className="split-row"><span>{t('import.r.cards')}</span><strong>{report.cardSettlementsLinked}</strong></li>}
        {(report.autoApplied ?? 0) > 0 && <li className="split-row"><span>{t('import.r.auto')}</span><strong>{report.autoApplied}</strong></li>}
        {report.suggestions > 0 && <li className="split-row"><span>{t('import.r.suggestions')}</span><strong>{report.suggestions}</strong></li>}
      </ul>
      {report.warnings.map((w) => <Warning key={w} code={w} />)}
      {report.skipped.length > 0 && (
        <details>
          <summary>{t('import.r.skippedList', { n: report.skipped.length })}</summary>
          <ul className="skipped">
            {report.skipped.map((s, i) => (
              <li key={i}>
                {t('import.r.line', { n: s.line })}: <strong>{t(SKIP_KEYS[s.reason] ?? 'import.skip.state')}</strong> — <code>{s.text}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {inboxCount > 0 && <a className="button" href={href('inbox')}>{t('import.toInbox')}</a>}
    </div>
  );
}

const FIELDS: { key: keyof MappingSpec['columns']; label: MessageKey; required?: boolean }[] = [
  { key: 'date', label: 'mapping.date', required: true },
  { key: 'valueDate', label: 'mapping.valueDate' },
  { key: 'description', label: 'mapping.description', required: true },
  { key: 'amount', label: 'mapping.amount' },
  { key: 'debit', label: 'mapping.debit' },
  { key: 'credit', label: 'mapping.credit' },
  { key: 'fee', label: 'mapping.fee' },
  { key: 'balance', label: 'mapping.balance' },
  { key: 'currency', label: 'mapping.currency' },
  { key: 'counterparty', label: 'mapping.counterparty' },
  { key: 'state', label: 'mapping.state' },
  { key: 'accountKey', label: 'mapping.accountKey' },
];

/** Map the columns of an unknown CSV layout once; the mapping is saved per bank (PRD F5). */
function MappingEditor({ header, sample, text, onSaved }: { header: string[]; sample: string[][]; text: string; onSaved: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const guess = guessColumns(header);
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<Partial<MappingSpec['columns']>>(guess);
  const [dateFormat, setDateFormat] = useState<MappingSpec['dateFormat']>('auto');
  const [decimal, setDecimal] = useState<MappingSpec['decimal']>(sample.flat().some((c) => /\d,\d{2}$/.test(c)) ? 'comma' : 'dot');
  const [okStates, setOkStates] = useState('');

  const spec: MappingSpec | null =
    columns.date && columns.description && (columns.amount || columns.debit || columns.credit)
      ? {
          name: name.trim() || t('mapping.untitled'),
          headers: header.filter(Boolean),
          delimiter: '',
          columns: columns as MappingSpec['columns'],
          dateFormat,
          decimal,
          okStates: okStates.split(',').map((s) => s.trim()).filter(Boolean),
        }
      : null;
  let preview: ParseResult | null = null;
  let previewError = '';
  if (spec) {
    try {
      preview = parseCsv(text, spec);
    } catch (e) {
      previewError = parseErrorText(e);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!spec || !name.trim()) return;
    await saveMapping(vault, spec);
    notify(t('mapping.saved', { name: spec.name }));
    onSaved();
  }

  return (
    <form onSubmit={save} noValidate>
      <p className="notice">{t('mapping.intro')}</p>
      <TextField label={t('mapping.name')} value={name} onChange={(e) => setName(e.target.value)} hint={t('mapping.nameHint')} required />
      <div className="form-grid">
        {FIELDS.map((f) => (
          <SelectField key={f.key} label={`${t(f.label)}${f.required ? ' *' : ''}`} value={columns[f.key] ?? ''} onChange={(e) => setColumns({ ...columns, [f.key]: e.target.value || undefined })}>
            <option value="">{t('mapping.none')}</option>
            {header.filter(Boolean).map((h) => <option key={h} value={h}>{h}</option>)}
          </SelectField>
        ))}
        <SelectField label={t('mapping.dateFormat')} value={dateFormat} onChange={(e) => setDateFormat(e.target.value as MappingSpec['dateFormat'])}>
          <option value="auto">{t('mapping.dateAuto')}</option>
          <option value="dmy">dd/mm/yyyy</option>
          <option value="ymd">yyyy-mm-dd</option>
          <option value="mdy">mm/dd/yyyy</option>
        </SelectField>
        <SelectField label={t('mapping.decimal')} value={decimal} onChange={(e) => setDecimal(e.target.value as MappingSpec['decimal'])}>
          <option value="comma">1.234,56</option>
          <option value="dot">1,234.56</option>
        </SelectField>
      </div>
      {columns.state && <TextField label={t('mapping.okStates')} value={okStates} onChange={(e) => setOkStates(e.target.value)} hint={t('mapping.okStatesHint')} />}
      <p className="hint">{t('mapping.amountHint')}</p>
      {previewError && <p className="error">⚠ {previewError}</p>}
      {preview && (
        <div className="notice">
          <p>{t('mapping.preview', { n: preview.rows.length, s: preview.skipped.length })}</p>
          <ul className="plain-list">
            {preview.rows.slice(0, 3).map((r) => (
              <li key={r.line} className="split-row"><span>{formatDate(r.date)} · {r.description}</span><Money cents={r.amount} /></li>
            ))}
          </ul>
        </div>
      )}
      <button className="button button-primary" disabled={!spec || !name.trim() || !preview}>{t('mapping.save')}</button>
    </form>
  );
}

function SavedMappings() {
  const vault = useVault();
  const mappings = useStore('bankMappings');
  if (mappings.length === 0) return null;
  return (
    <section className="card" aria-labelledby="maps-h">
      <h2 id="maps-h">{t('mapping.savedTitle')}</h2>
      <ul className="plain-list">
        {mappings.map((m) => (
          <li key={m.id} className="split-row">
            <span>
              {m.name} <span className="muted">· {m.headers.slice(0, 4).join(', ')}{m.headers.length > 4 ? '…' : ''}</span>
            </span>
            {!m.builtIn && (
              <button type="button" className="button button-quiet" onClick={() => void vault.remove('bankMappings', m.id)} aria-label={t('mapping.deleteNamed', { name: m.name })}>
                {t('common.delete')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
