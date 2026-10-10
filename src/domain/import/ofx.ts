import type { ParseResult, ParsedRow, StatementInfo } from './types';
import { ImportParseError } from './types';
import { parseAmount, squash } from './text';

/**
 * OFX / QFX statements, both the old SGML form (OFX 1.x, tags left open)
 * and the XML form (OFX 2.x). One file can hold several bank or card
 * statements; each becomes its own sub-account, keyed by the last 4
 * characters of the account id.
 */

export function isOfx(text: string): boolean {
  return /OFXHEADER\s*:|<OFX>/i.test(text.slice(0, 4000));
}

/** Value of a leaf tag: "<NAME>value" up to the next tag or line end. */
function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? decode(m[1]!.trim()) : '';
}

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Aggregate blocks such as <STMTTRN>…</STMTTRN>; in SGML the closing tag may be missing. */
function blocks(text: string, name: string, until: string[] = []): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${name}>`, 'gi');
  const starts: number[] = [];
  for (let m = open.exec(text); m; m = open.exec(text)) starts.push(m.index);
  starts.forEach((start, i) => {
    const rest = text.slice(start + name.length + 2);
    const ends = [`</${name}>`, `<${name}>`, ...until.map((u) => `</${u}>`)]
      .map((e) => rest.toUpperCase().indexOf(e.toUpperCase()))
      .filter((n) => n >= 0);
    const end = Math.min(...ends, i + 1 < starts.length ? starts[i + 1]! - start - name.length - 2 : rest.length);
    out.push(rest.slice(0, end));
  });
  return out;
}

/** OFX date "20260915120000.000[+2:CET]" → "2026-09-15". */
export function ofxDate(raw: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function ofxAmount(raw: string): number | null {
  const v = raw.trim();
  if (!v) return null;
  // OFX uses a dot; some European banks write a comma.
  return parseAmount(v, /,\d{1,2}$/.test(v) && !v.includes('.') ? 'comma' : 'dot');
}

export function parseOfx(text: string): ParseResult {
  const result: ParseResult = { format: 'ofx', label: 'OFX', rows: [], skipped: [], statements: [], warnings: [] };
  const statements = [...blocks(text, 'STMTRS'), ...blocks(text, 'CCSTMTRS')];
  if (statements.length === 0) throw new ImportParseError('noRows');
  let line = 0;
  for (const stmt of statements) {
    const acct = tag(stmt, 'ACCTID').replace(/\s/g, '');
    const key = acct ? acct.slice(-4) : 'main';
    const currency = tag(stmt, 'CURDEF').toUpperCase() || 'EUR';
    const info: StatementInfo = { accountKey: key, ...(acct ? { last4: key } : {}) };
    const list = blocks(stmt, 'BANKTRANLIST')[0] ?? stmt;
    const start = ofxDate(tag(list, 'DTSTART'));
    const end = ofxDate(tag(list, 'DTEND'));
    if (start) info.periodStart = start;
    if (end) info.periodEnd = end;

    for (const trn of blocks(list, 'STMTTRN', ['BANKTRANLIST'])) {
      line++;
      const raw = squash(trn.replace(/<[^>]+>/g, ' ')).slice(0, 160);
      let amount = ofxAmount(tag(trn, 'TRNAMT'));
      // <CURRENCY>: TRNAMT is in a foreign currency; <ORIGCURRENCY>: TRNAMT is already in CURDEF.
      // CURRATE is the value of one foreign unit in CURDEF.
      const foreign = blocks(trn, 'CURRENCY')[0];
      const foreignCcy = foreign ? tag(foreign, 'CURSYM').toUpperCase() : '';
      const foreignRate = foreign ? Number(tag(foreign, 'CURRATE').replace(',', '.')) : NaN;
      const foreignAmount = amount;
      if (foreignCcy && foreignCcy !== currency && amount !== null) amount = foreignRate > 0 ? Math.round(amount * foreignRate) : null;
      const date = ofxDate(tag(trn, 'DTPOSTED'));
      if (currency !== 'EUR') {
        result.skipped.push({ line, reason: 'currency', text: raw });
        continue;
      }
      if (amount === null || !date) {
        result.skipped.push({ line, reason: 'unparseable', text: raw });
        continue;
      }
      if (amount === 0) {
        result.skipped.push({ line, reason: 'zero', text: raw });
        continue;
      }
      const name = squash(tag(trn, 'NAME') || tag(blocks(trn, 'PAYEE')[0] ?? '', 'NAME'));
      const memo = squash(tag(trn, 'MEMO'));
      const valueDate = ofxDate(tag(trn, 'DTAVAIL'));
      const orig = blocks(trn, 'ORIGCURRENCY')[0];
      const origCcy = orig ? tag(orig, 'CURSYM').toUpperCase() : '';
      const rate = orig ? Number(tag(orig, 'CURRATE').replace(',', '.')) : NaN;
      const row: ParsedRow = {
        line,
        date,
        ...(valueDate && valueDate !== date ? { valueDate } : {}),
        amount,
        description: name || memo || tag(trn, 'TRNTYPE') || 'Bank entry',
        ...(memo && name && memo !== name ? { details: memo } : {}),
        ...(name ? { counterparty: name } : {}),
        // CURRATE converts the original amount into the statement currency.
        ...(origCcy && origCcy !== 'EUR' && rate > 0 ? { originalCurrency: origCcy, originalAmount: Math.round(amount / rate) } : {}),
        ...(foreignCcy && foreignCcy !== 'EUR' && foreignAmount !== null ? { originalCurrency: foreignCcy, originalAmount: foreignAmount } : {}),
        accountKey: key,
      };
      result.rows.push(row);
    }

    const ledger = blocks(stmt, 'LEDGERBAL')[0];
    const balance = ledger ? ofxAmount(tag(ledger, 'BALAMT')) : null;
    const asOf = ledger ? ofxDate(tag(ledger, 'DTASOF')) : '';
    const dates = result.rows.filter((r) => r.accountKey === key).map((r) => r.date).sort();
    if (!info.periodStart && dates[0]) info.periodStart = dates[0];
    if (!info.periodEnd && dates.length) info.periodEnd = dates.at(-1)!;
    if (balance !== null && currency === 'EUR') {
      info.closingBalance = balance;
      // The ledger balance is as of DTASOF, which can be after the last transaction.
      if (asOf && (!info.periodEnd || asOf > info.periodEnd)) info.periodEnd = asOf;
      if (info.periodEnd && dates.length && dates.at(-1)! > info.periodEnd) result.warnings.push(`balanceMismatch:${key}`);
    }
    result.statements.push(info);
  }
  return result;
}
