import type { ParseResult, ParsedRow, StatementInfo } from './types';
import { ImportParseError } from './types';
import { parseAmount, squash } from './text';

/**
 * ISO 20022 CAMT.053 bank-to-customer statement (any 001.xx version).
 * Takes a parsed XML Document so the domain stays free of browser globals;
 * the caller supplies DOMParser.
 */

const kids = (el: Element | Document, name: string): Element[] => Array.from(el.getElementsByTagName('*')).filter((e) => e.localName === name);
const child = (el: Element | undefined, ...path: string[]): Element | undefined => {
  let cur: Element | undefined = el;
  for (const p of path) {
    cur = cur ? Array.from(cur.children).find((c) => c.localName === p) : undefined;
  }
  return cur;
};
const text = (el: Element | undefined, ...path: string[]) => child(el, ...path)?.textContent?.trim() ?? '';

function signed(amountEl: Element | undefined, indicator: string): number | null {
  const v = parseAmount(amountEl?.textContent ?? '', 'dot');
  if (v === null) return null;
  return indicator === 'DBIT' ? -Math.abs(v) : Math.abs(v);
}

const day = (el: Element | undefined) => (text(el, 'Dt') || text(el, 'DtTm')).slice(0, 10);

export function isCamt053(xml: string): boolean {
  return /<BkToCstmrStmt/.test(xml) || /camt\.053/.test(xml);
}

export function parseCamt053(doc: Document): ParseResult {
  if (doc.getElementsByTagName('parsererror').length) throw new ImportParseError('badXml');
  const result: ParseResult = { format: 'camt053', label: 'CAMT.053', rows: [], skipped: [], statements: [], warnings: [] };
  const statements = kids(doc, 'Stmt');
  if (statements.length === 0) throw new ImportParseError('noRows');
  let line = 0;
  for (const stmt of statements) {
    const iban = text(child(stmt, 'Acct'), 'Id', 'IBAN').replace(/\s/g, '');
    const key = iban ? iban.slice(-4) : 'main';
    const info: StatementInfo = { accountKey: key, ...(iban ? { last4: key } : {}) };
    for (const bal of Array.from(stmt.children).filter((c) => c.localName === 'Bal')) {
      const code = text(bal, 'Tp', 'CdOrPrtry', 'Cd');
      const value = signed(child(bal, 'Amt'), text(bal, 'CdtDbtInd'));
      if (value === null) continue;
      if (code === 'OPBD' || code === 'PRCD') info.openingBalance = value;
      if (code === 'CLBD') {
        info.closingBalance = value;
        info.periodEnd = day(child(bal, 'Dt'));
      }
    }
    const from = text(stmt, 'FrToDt', 'FrDtTm').slice(0, 10);
    const to = text(stmt, 'FrToDt', 'ToDtTm').slice(0, 10);
    if (from) info.periodStart = from;
    if (to) info.periodEnd = to;

    for (const ntry of Array.from(stmt.children).filter((c) => c.localName === 'Ntry')) {
      line++;
      const amtEl = child(ntry, 'Amt');
      const status = text(ntry, 'Sts', 'Cd') || text(ntry, 'Sts');
      const raw = squash(ntry.textContent ?? '').slice(0, 160);
      if (status && status !== 'BOOK') {
        result.skipped.push({ line, reason: status === 'PDNG' ? 'pending' : 'state', text: raw });
        continue;
      }
      if ((amtEl?.getAttribute('Ccy') ?? 'EUR') !== 'EUR') {
        result.skipped.push({ line, reason: 'currency', text: raw });
        continue;
      }
      const indicator = text(ntry, 'CdtDbtInd');
      const amount = signed(amtEl, indicator);
      const date = day(child(ntry, 'BookgDt'));
      if (amount === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        result.skipped.push({ line, reason: 'unparseable', text: raw });
        continue;
      }
      const valueDate = day(child(ntry, 'ValDt'));
      const tx = child(ntry, 'NtryDtls', 'TxDtls');
      const partyRole = indicator === 'DBIT' ? 'Cdtr' : 'Dbtr';
      const party = text(child(tx, 'RltdPties', partyRole), 'Nm') || text(child(tx, 'RltdPties', partyRole, 'Pty'), 'Nm');
      const partyIban = text(child(tx, 'RltdPties', `${partyRole}Acct`), 'Id', 'IBAN').replace(/\s/g, '');
      const ustrd = tx ? kids(tx, 'Ustrd').map((e) => e.textContent?.trim()).filter(Boolean).join(' ') : '';
      const info2 = text(ntry, 'AddtlNtryInf');
      const instd = child(tx, 'AmtDtls', 'InstdAmt', 'Amt');
      const instdCcy = instd?.getAttribute('Ccy');
      const row: ParsedRow = {
        line,
        date,
        ...(valueDate && valueDate !== date ? { valueDate } : {}),
        amount,
        description: squash(info2 || party || ustrd || 'Bank entry'),
        ...(ustrd && ustrd !== info2 ? { details: squash(ustrd) } : {}),
        ...(party ? { counterparty: squash(party) } : {}),
        ...(partyIban.length >= 15 ? { counterpartyIbanLast4: partyIban.slice(-4) } : {}),
        ...(instd && instdCcy && instdCcy !== 'EUR'
          ? { originalCurrency: instdCcy, originalAmount: Math.sign(amount) * Math.abs(parseAmount(instd.textContent ?? '', 'dot') ?? 0) }
          : {}),
        accountKey: key,
      };
      result.rows.push(row);
    }
    const dates = result.rows.filter((r) => r.accountKey === key).map((r) => r.date).sort();
    if (!info.periodStart && dates[0]) info.periodStart = dates[0];
    if (!info.periodEnd && dates.length) info.periodEnd = dates.at(-1)!;
    result.statements.push(info);
    if (info.openingBalance !== undefined && info.closingBalance !== undefined) {
      const sum = result.rows.filter((r) => r.accountKey === key).reduce((s, r) => s + r.amount, 0);
      if (info.openingBalance + sum !== info.closingBalance) result.warnings.push(`balanceMismatch:${key}`);
    }
  }
  return result;
}
