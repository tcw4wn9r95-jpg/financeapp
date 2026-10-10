import type { ParseResult, ParsedRow, StatementInfo } from './types';
import { ImportParseError } from './types';
import { ibanLast4, maskCardNumbers, parseAmount, parseBankDate, squash, stripIbans } from './text';

/**
 * Spuerkeess (BCEE) current-account PDF statement, after text extraction.
 *
 * Booking lines look like
 *   03.09.26   DEBIT TPV CACTUS HOWALD 01.09   03.09.26   84,37 -
 * and may be followed by detail lines: a wrapped counterparty name, an
 * address, "IBAN …", "Beneficiary bank: …", "Communication: …".
 * The statement opens with "Old Balance" and closes with "New Balance".
 */

const ROW = /^(\d{2}\.\d{2}\.\d{2})\s+(.+?)\s{2,}(\d{2}\.\d{2}\.\d{2})\s{2,}([\d.]+,\d{2})\s*([+-])$/;
const BALANCE = /^(Old|New) Balance\s+([\d.]+,\d{2})\s*([+-])$/;
const NOISE = [
  /^Your contact:/, /^Email:/, /^Tel\.:/, /^Date:/, /^Statement N/, /^Banque et Caisse d'Epargne/,
  /^Date\s+Description/, /^\d+\/\d+$/, /\(Continuation\)/, /^Your deposit is covered/, /^More information at/,
];

export function isSpuerkeessStatement(lines: readonly string[]): boolean {
  const text = lines.slice(0, 40).join('\n');
  return /spuerkeess/i.test(text) && /Old Balance/.test(lines.join('\n'));
}

export function parseSpuerkeess(lines: readonly string[]): ParseResult {
  const result: ParseResult = { format: 'pdf-spuerkeess', label: 'Spuerkeess', rows: [], skipped: [], statements: [], warnings: [] };
  let last4: string | undefined;
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  let opening: number | undefined;
  let closing: number | undefined;
  let inBody = false;
  let current: (ParsedRow & { mode: 'head' | 'comm' | 'done' }) | null = null;

  const flush = () => {
    if (!current) return;
    const { mode: _mode, ...row } = current;
    row.description = squash(maskCardNumbers(row.description));
    if (row.details) row.details = squash(maskCardNumbers(stripIbans(row.details)));
    if (row.counterparty) row.counterparty = squash(row.counterparty);
    result.rows.push(row);
    current = null;
  };

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const acc = /ACCOUNT IN EUR:\s*IBAN\s+([A-Z0-9 ]+)/.exec(line);
    if (acc && !last4) last4 = ibanLast4(`${acc[1]}`) ?? acc[1]!.replace(/\s/g, '').slice(-4);
    const period = /Statement \d+:\s*(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/.exec(line);
    if (period) {
      periodStart = parseBankDate(period[1]!, 'dmy') ?? undefined;
      periodEnd = parseBankDate(period[2]!, 'dmy') ?? undefined;
    }
    const bal = BALANCE.exec(line);
    if (bal) {
      const value = parseAmount(`${bal[2]}${bal[3]}`, 'comma');
      if (bal[1] === 'Old') {
        opening = value ?? undefined;
        inBody = true;
      } else if (inBody) {
        flush();
        closing = value ?? undefined;
        inBody = false;
      }
      return;
    }
    if (!inBody || NOISE.some((re) => re.test(line))) return;

    const m = ROW.exec(line);
    if (m) {
      flush();
      const amount = parseAmount(`${m[4]}${m[5]}`, 'comma');
      const date = parseBankDate(m[1]!, 'dmy');
      const valueDate = parseBankDate(m[3]!, 'dmy');
      if (amount === null || !date) {
        result.skipped.push({ line: index + 1, reason: 'unparseable', text: line });
        return;
      }
      const description = m[2]!;
      const party = /(?:IN FAVOUR OF|FROM)\s+(.+)$/.exec(description);
      current = {
        line: index + 1,
        date,
        ...(valueDate && valueDate !== date ? { valueDate } : {}),
        amount,
        description,
        ...(party ? { counterparty: party[1]! } : {}),
        accountKey: 'main',
        mode: 'head',
      };
      return;
    }
    if (!current) {
      result.skipped.push({ line: index + 1, reason: 'unparseable', text: line });
      return;
    }
    const row = current as ParsedRow & { mode: 'head' | 'comm' | 'done' };
    if (/^IBAN\s/.test(line)) {
      row.counterpartyIbanLast4 = ibanLast4(line);
      row.mode = 'done';
    } else if (/^(Beneficiary bank|Ordering party bank):/.test(line)) {
      row.mode = 'done';
    } else if (/^Communication:/.test(line)) {
      row.details = line.replace(/^Communication:\s*/, '');
      row.mode = 'comm';
    } else if (row.mode === 'comm') {
      row.details = `${row.details ?? ''} ${line}`;
    } else if (row.mode === 'head' && row.counterparty && !/\d/.test(line)) {
      // Wrapped counterparty name ("… IN FAVOUR OF JANE" / "DOE").
      row.counterparty = `${row.counterparty} ${line}`;
      row.description = `${row.description} ${line}`;
    } else if (row.mode === 'head' && !row.counterparty) {
      // Reference lines under a direct debit, e.g. "NR.INV/…".
      row.details = `${row.details ?? ''} ${line}`;
    }
    // Anything else (addresses) is dropped on purpose.
  });
  flush();

  if (result.rows.length === 0 && opening === undefined) throw new ImportParseError('noRows');
  const statement: StatementInfo = {
    accountKey: 'main',
    ...(last4 ? { last4 } : {}),
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    ...(opening !== undefined ? { openingBalance: opening } : {}),
    ...(closing !== undefined ? { closingBalance: closing } : {}),
  };
  result.statements.push(statement);
  if (opening !== undefined && closing !== undefined) {
    const sum = result.rows.reduce((s, r) => s + r.amount, 0);
    if (opening + sum !== closing) result.warnings.push('balanceMismatch:main');
  }
  return result;
}
