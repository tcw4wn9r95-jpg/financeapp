/**
 * Generates the anonymised import fixtures in fixtures/import/. Every name,
 * IBAN, card number and amount is fictional; the layouts copy the real
 * exports of Spuerkeess, Worldline (Visa) and Revolut so the parsers can be
 * tested and demoed without anyone's data.
 *
 *   npm run fixtures:import
 *
 * PDFs are printed with Playwright's Chromium. If Playwright is not
 * installed locally, set PLAYWRIGHT_MODULE to its path.
 *
 * Scenario: Jane and John Doe, September 2026.
 * - Joint Spuerkeess current account     IBAN …1234
 * - John's Revolut (current + savings)   IBAN …5678, card top-up "REVOLUT**5678"
 * - John's Revolut "Compte flexible"     no statement; recognised by text
 * - John's Visa (Worldline)              card …4321, settled from …1234
 * - Jane's savings (CAMT.053)            IBAN …9876
 * - Jane's credit card (French CSV)      card …2222, settled from …1234
 * - A consumer loan (Buy Way)            repaid by "DIRECT DEBIT BUY WAY" 
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../fixtures/import/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const write = (name: string, data: string | Uint8Array) => writeFileSync(new URL(name, OUT), data);

const eu = (cents: number) => {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(abs % 100).padStart(2, '0')}`;
};
const dot = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

// ------------------------------------------------------------ Spuerkeess
interface BankLine { date: string; desc: string; value: string; amount: number; extra?: string[] }
const spk: BankLine[] = [
  { date: '01.09.26', desc: 'DEBIT REVOLUT**5678* 30.08', value: '01.09.26', amount: -20000 },
  { date: '02.09.26', desc: 'STANDING ORDER IN FAVOUR OF JOHN DOE', value: '02.09.26', amount: -120000, extra: ['IBAN LT00 3250 0000 0000 5678', 'Beneficiary bank: REVOLT21', 'Communication: Provisions'] },
  { date: '03.09.26', desc: 'DEBIT TPV CACTUS HOWALD 01.09', value: '03.09.26', amount: -8437 },
  { date: '05.09.26', desc: 'DIRECT DEBIT 4999000000004321 CARTE VISA', value: '05.09.26', amount: -61240 },
  { date: '07.09.26', desc: 'DIRECT DEBIT 5355000000002222 CARTE MASTERCARD', value: '07.09.26', amount: -14320 },
  { date: '07.09.26', desc: 'DIRECT DEBIT BUY WAY SA 07/09/26', value: '07.09.26', amount: -18950 },
  { date: '12.09.26', desc: 'DIRECT DEBIT ENOVOS LUXEMBOURG S.A.', value: '12.09.26', amount: -12850, extra: ['NR.INV/0000123/2026'] },
  { date: '15.09.26', desc: "CREDIT TRANSFER FROM CAISSE POUR L'AVENIR DES ENFANTS", value: '15.09.26', amount: 31504, extra: ['B.P. 394 L-2013 LUXEMBOURG', 'Ordering party bank: BCEELULL', 'Communication: CAE DOSSIER: 0000000000000 DECOMPTE DU', '12.09.26 PRESTATIONS FAMILIALES'] },
  { date: '18.09.26', desc: "DEBIT TPV AUCHAN CLOCHE D'OR 16.09", value: '18.09.26', amount: -6780 },
  { date: '18.09.26', desc: "DEBIT TPV AUCHAN CLOCHE D'OR 16.09", value: '18.09.26', amount: -6780 },
  { date: '22.09.26', desc: 'INSTANT CREDIT TRANSFER S-NET : 265-000123 IN FAVOUR OF JANE', value: '22.09.26', amount: -50000, extra: ['DOE', 'IBAN LU00 0141 0000 0000 9876', 'Beneficiary bank: CELLLULL', 'Communication: Savings'] },
  { date: '25.09.26', desc: 'CREDIT TRANSFER FROM EXAMPLE EMPLOYER S.A.', value: '25.09.26', amount: 512000, extra: ['1 RUE DE L\'EXEMPLE L-1000 LUXEMBOURG', 'Ordering party bank: BGLLLULL', 'Communication: SALAIRE 09/2026'] },
  { date: '28.09.26', desc: 'CREDIT TRANSFER FROM OTHER EMPLOYER SARL', value: '26.09.26', amount: 340000, extra: ['Ordering party bank: CCRALULL', 'Communication: SALAIRE SEPTEMBRE'] },
  { date: '28.09.26', desc: 'DIRECT DEBIT POST LUXEMBOURG', value: '28.09.26', amount: -4999 },
  { date: '30.09.26', desc: 'STANDING ORDER IN FAVOUR OF EXAMPLE LANDLORD SCI', value: '30.09.26', amount: -195000, extra: ['IBAN LU00 0030 0000 0000 0001', 'Beneficiary bank: BGLLLULL', 'Communication: Loyer octobre'] },
];
const spkOpening = 1250000;
const spkClosing = spkOpening + spk.reduce((s, l) => s + l.amount, 0);

// ------------------------------------------------------------ Worldline
interface CardLine { tx: string; book: string; desc: string; place: string; fx?: string; amount: number }
const visaAug: CardLine[] = [
  { tx: '01/08/2026', book: '02/08/2026', desc: 'DELHAIZE ALZINGEN', place: 'Alzingen', amount: -9214 },
  { tx: '06/08/2026', book: '07/08/2026', desc: 'AMAZON* AB12CD34E', place: 'LUXEMBOURG', amount: -4599 },
  { tx: '14/08/2026', book: '15/08/2026', desc: 'SPOTIFY', place: 'STOCKHOLM', amount: -1799 },
  { tx: '20/08/2026', book: '21/08/2026', desc: 'LUXAIR', place: 'LUXEMBOURG', amount: -45628 },
];
const visaSep: CardLine[] = [
  { tx: '30/08/2026', book: '31/08/2026', desc: 'AMAZON* ZZ98YY76X', place: 'LUXEMBOURG', amount: -2350 },
  { tx: '03/09/2026', book: '04/09/2026', desc: 'Delhaize Alzingen', place: 'Alzingen', amount: -7812 },
  { tx: '14/09/2026', book: '15/09/2026', desc: 'SPOTIFY', place: 'STOCKHOLM', amount: -1799 },
  { tx: '20/09/2026', book: '21/09/2026', desc: 'BOOKSHOP EXAMPLE', place: 'LONDON', fx: '-25,00 GBP', amount: -2963 },
  { tx: '26/09/2026', book: '28/09/2026', desc: 'RESTAURANT EXEMPLO', place: 'LISBOA', amount: -6420 },
];
const total = (l: CardLine[]) => l.reduce((s, x) => s + x.amount, 0);

// ---------------------------------------------------------------- Revolut
interface RevRow { type: string; product: string; started: string; completed: string; desc: string; amount: number; fee?: number; state?: string }
const rev: RevRow[] = [
  { type: 'Topup', product: 'Current', started: '2026-08-30 10:02:11', completed: '2026-08-30 10:02:12', desc: 'Top-Up by *1234', amount: 20000 },
  { type: 'Card Payment', product: 'Current', started: '2026-08-31 18:11:40', completed: '2026-09-01 04:20:02', desc: 'Bao8', amount: -3650 },
  { type: 'Transfer', product: 'Current', started: '2026-09-01 12:00:00', completed: '2026-09-01 12:00:00', desc: 'Revpoints Spare change', amount: -50 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-01 11:59:59', completed: '2026-09-01 22:10:00', desc: 'Delhaize', amount: -4950 },
  { type: 'Deposit', product: 'Current', started: '2026-09-02 06:00:00', completed: '2026-09-02 06:00:01', desc: 'Payment from DOE JANE+JOHN', amount: 120000 },
  { type: 'Transfer', product: 'Current', started: '2026-09-02 06:05:00', completed: '2026-09-02 06:05:01', desc: 'To EUR Compte flexible', amount: -100000 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-04 09:13:29', completed: '2026-09-04 22:50:15', desc: 'T.ZONE BOBA', amount: -1290 },
  { type: 'Transfer', product: 'Current', started: '2026-09-04 09:13:30', completed: '2026-09-04 09:13:30', desc: 'Revpoints Spare change', amount: -10 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-05 10:09:55', completed: '2026-09-06 00:35:29', desc: 'Luxembourg parking', amount: -100 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-05 10:20:00', completed: '2026-09-06 00:40:00', desc: 'Luxembourg parking', amount: -100 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-08 08:26:34', completed: '', desc: 'Sweet & Coffee', amount: -156, state: 'REVERTED' },
  { type: 'Card Payment', product: 'Current', started: '2026-09-09 13:02:23', completed: '2026-09-10 02:39:31', desc: 'Q8', amount: -6200 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-12 19:06:03', completed: '2026-09-14 07:00:01', desc: 'Online shop', amount: -16992, fee: 170 },
  { type: 'Transfer', product: 'Current', started: '2026-09-15 16:49:37', completed: '2026-09-15 16:49:38', desc: 'From EUR Compte flexible', amount: 15000 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-15 17:00:00', completed: '2026-09-16 03:00:00', desc: 'Garage Example', amount: -15000 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-18 12:00:00', completed: '2026-09-18 22:00:00', desc: 'ALDI', amount: -3979 },
  { type: 'Transfer', product: 'Current', started: '2026-09-21 10:42:52', completed: '2026-09-21 10:42:52', desc: 'Revpoints Spare change', amount: -88 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-21 10:42:51', completed: '2026-09-21 22:48:27', desc: 'Auchan', amount: -3112 },
  { type: 'Card Payment', product: 'Current', started: '2026-09-29 15:42:29', completed: '', desc: 'Anthropic', amount: -1044, state: 'PENDING' },
  { type: 'Interest', product: 'Deposit', started: '2026-09-28 20:24:47', completed: '2026-09-28 20:24:47', desc: 'Net interest paid to "Instant Access Savings" for Sep 29, 2026', amount: 2 },
];

function revolutCsv(rows: RevRow[]): string {
  const balances = new Map<string, number>([['Current', 41250], ['Deposit', 1000]]);
  const lines = ['Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'];
  for (const r of rows) {
    const state = r.state ?? 'COMPLETED';
    let bal = '';
    if (state === 'COMPLETED') {
      const b = balances.get(r.product)! + r.amount - (r.fee ?? 0);
      balances.set(r.product, b);
      bal = dot(b);
    }
    const desc = r.desc.includes(',') || r.desc.includes('"') ? `"${r.desc.replace(/"/g, '""')}"` : r.desc;
    lines.push([r.type, r.product, r.started, r.completed, desc, dot(r.amount), dot(r.fee ?? 0), 'EUR', state, bal].join(','));
  }
  return lines.join('\n') + '\n';
}

// The full month, then two overlapping halves (rows 1-14 and 9-20) for the duplicate test.
const balancedRows = (rows: RevRow[]) => rows;
write('revolut-john-2026-09.csv', revolutCsv(balancedRows(rev)));
{
  // Running balances must stay true in each half, so compute them over the
  // whole month and keep the slices.
  const full = revolutCsv(rev).trim().split('\n');
  const [head, ...body] = full;
  write('revolut-john-2026-09-part1.csv', [head, ...body.slice(0, 14)].join('\n') + '\n');
  write('revolut-john-2026-09-part2.csv', [head, ...body.slice(8)].join('\n') + '\n');
}

// --------------------------------------------------------------- CAMT.053
const camt = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>EXAMPLE-0001</MsgId><CreDtTm>2026-10-01T06:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-2026-09</Id>
      <FrToDt><FrDtTm>2026-09-01T00:00:00</FrDtTm><ToDtTm>2026-09-30T23:59:59</ToDtTm></FrToDt>
      <Acct><Id><IBAN>LU000141000000009876</IBAN></Id><Ccy>EUR</Ccy><Ownr><Nm>JANE DOE</Nm></Ownr></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">8000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">8478.12</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-30</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-09-22</Dt></BookgDt><ValDt><Dt>2026-09-22</Dt></ValDt>
        <AddtlNtryInf>VIREMENT SEPA RECU</AddtlNtryInf>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>DOE JANE+JOHN</Nm></Dbtr><DbtrAcct><Id><IBAN>LU280019400000001234</IBAN></Id></DbtrAcct></RltdPties>
          <RmtInf><Ustrd>Savings</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">25.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-09-24</Dt></BookgDt><ValDt><Dt>2026-09-24</Dt></ValDt>
        <AddtlNtryInf>FRAIS DE TENUE DE COMPTE</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">3.12</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-09-30</Dt></BookgDt><ValDt><Dt>2026-09-30</Dt></ValDt>
        <AddtlNtryInf>INTERETS CREDITEURS</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">40.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>PDNG</Sts>
        <BookgDt><Dt>2026-09-30</Dt></BookgDt>
        <AddtlNtryInf>PRELEVEMENT EN ATTENTE</AddtlNtryInf>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
write('camt053-jane-savings-2026-09.xml', camt);

// ------------------------------------------- second CSV layout (French)
const janeCard = [
  ['Date opération', 'Date valeur', 'Libellé', 'Débit', 'Crédit'],
  ['02/09/2026', '03/09/2026', 'PHARMACIE DU CENTRE LUXEMBOURG', '23,40', ''],
  ['05/09/2026', '06/09/2026', 'ZARA ROYAL HAMILTON', '89,95', ''],
  ['07/09/2026', '07/09/2026', 'PAIEMENT RECU MERCI', '', '143,20'],
  ['13/09/2026', '14/09/2026', 'KINEPOLIS KIRCHBERG', '31,00', ''],
  ['19/09/2026', '20/09/2026', 'BOULANGERIE FISCHER', '12,60', ''],
  ['27/09/2026', '28/09/2026', 'CACTUS BERELDANGE', '1.064,32', ''],
];
write('card-jane-2026-09.csv', janeCard.map((r) => r.join(';')).join('\n') + '\n');

// ------------------------------------------------------------------ PDFs
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const page = (body: string) => `<section class="page">${body}</section>`;
const css = `
@page { size: A4; margin: 0 }
body { margin: 0; font: 9pt Helvetica, Arial, sans-serif }
.page { position: relative; width: 210mm; height: 297mm; page-break-after: always; overflow: hidden }
.t { position: absolute; white-space: pre }
.r { text-align: right }
`;
let y = 0;
const at = (x: number, text: string, opts: { right?: boolean; bold?: boolean } = {}) =>
  opts.right
    ? `<div class="t r" style="right:${210 - x}mm;top:${y}mm${opts.bold ? ';font-weight:bold' : ''}">${esc(text)}</div>`
    : `<div class="t" style="left:${x}mm;top:${y}mm${opts.bold ? ';font-weight:bold' : ''}">${esc(text)}</div>`;
const nl = (h = 4.2) => {
  y += h;
  return '';
};

function spuerkeessHtml(): string {
  const header = (n: number, continuation: boolean) => {
    y = 12;
    let h = at(120, 'Your contact:') + at(150, 'Finance Center Example') + nl();
    h += at(120, 'Email:') + at(150, 'example@spuerkeess.lu') + nl();
    h += at(120, 'Tel.:') + at(150, '(+352) 4015-0000') + nl();
    h += at(120, 'Date:') + at(150, '30.09.2026') + nl();
    h += at(120, 'Statement N°:') + at(150, '009/26') + nl(8);
    h += at(190, `${n}/2`, { right: true }) + nl(8);
    if (continuation) {
      h += at(15, 'Date') + at(32, 'Description') + at(70, '(Continuation) Account: IBAN LU28 0019 4000 0000 1234') + at(160, 'Value date') + at(195, 'Amount in EUR', { right: true }) + nl(8);
    }
    return h;
  };
  const footer = () => {
    const keep = y;
    y = 285;
    const f = at(15, "Banque et Caisse d'Epargne de l'Etat, Luxembourg, établissement public autonome, 1, Place de Metz, L-1930 Luxembourg");
    y = keep;
    return f;
  };
  let p1 = header(1, false);
  p1 += at(120, 'DOE JANE') + nl() + at(120, '1 RUE DE L’EXEMPLE') + nl() + at(120, 'L-1000 LUXEMBOURG') + nl(10);
  p1 += at(15, 'CURRENT ACCOUNT IN EUR: IBAN LU28 0019 4000 0000 1234', { bold: true }) + nl();
  p1 += at(15, 'HOLDER: DOE JANE+JOHN') + nl();
  p1 += at(15, 'New Balance') + at(195, `${eu(spkClosing)}+`, { right: true }) + nl(8);
  p1 += at(15, 'Date') + at(32, 'Description') + at(70, 'Statement 009: 01.09.2026 - 30.09.2026') + at(160, 'Value date') + at(195, 'Amount in EUR', { right: true }) + nl(6);
  p1 += at(32, 'Old Balance') + at(195, `${eu(spkOpening)}+`, { right: true }) + nl();
  const lineHtml = (l: BankLine) => {
    let h = at(15, l.date) + at(32, l.desc) + at(160, l.value) + at(195, `${eu(l.amount)} ${l.amount < 0 ? '-' : '+'}`, { right: true }) + nl();
    for (const e of l.extra ?? []) h += at(32, e) + nl();
    return h;
  };
  const first = spk.slice(0, 8);
  const rest = spk.slice(8);
  for (const l of first) p1 += lineHtml(l);
  p1 += footer();
  let p2 = header(2, true);
  for (const l of rest) p2 += lineHtml(l);
  p2 += at(32, 'New Balance') + at(195, `${eu(spkClosing)}+`, { right: true }) + nl(10);
  p2 += footer();
  // A debit note annex after the statement, as in the real file.
  p2 += at(60, 'Debit Note') + at(120, 'Ref.: MOB000000S000000') + nl() + at(60, 'Date: 22.09.2026') + at(120, 'Nbr: IBAN LU28 0019 4000 0000 1234') + nl();
  return page(p1) + page(p2);
}

function worldlineHtml(lines: CardLine[], dated: string, debitOn: string): string {
  y = 15;
  let h = at(15, 'For additional repayments, please indicate:') + nl(6);
  h += at(15, 'Account :') + nl() + at(15, 'Reference :') + at(40, '000000000') + nl();
  h += at(120, 'DOE JOHN') + nl() + at(25, 'Credit limit :') + at(70, '2.500,00 EUR', { right: true }) + at(120, '1 RUE DE L’EXEMPLE') + nl() + at(120, 'L-1000 LUXEMBOURG') + nl(10);
  h += at(25, 'Visa Premier', { bold: true }) + nl();
  h += at(140, `Statement dated ${dated}`) + at(190, 'Folio 1', { right: true }) + nl(8);
  h += at(20, 'Transaction date') + at(45, 'Booking date') + at(70, 'Description') + at(125, 'Place') + at(165, 'Currency amount', { right: true }) + at(192, 'Amount EUR', { right: true }) + nl(6);
  h += at(20, 'OPERATIONS WITH CARD VISA NUMBER 4999 0000 0000 4321', { bold: true }) + nl();
  for (const l of lines) {
    h += at(24, l.tx) + at(47, l.book) + at(70, l.desc) + at(125, l.place) + (l.fx ? at(165, l.fx, { right: true }) : '') + at(192, `-${eu(l.amount)}`, { right: true }) + nl();
    if (l.fx) h += at(70, 'Exchange rate = 0,844200') + nl();
  }
  h += at(70, 'TOTAL CARD TRANSACTIONS') + at(192, `-${eu(total(lines))}`, { right: true }) + nl(6);
  h += at(55, 'NEW BALANCE TOTAL', { bold: true }) + at(192, `-${eu(total(lines))}`, { right: true }) + nl(6);
  h += at(20, `The amount of ${eu(total(lines))} EUR will be debited from the account Spuerkeess IBAN LU28 0019 4000 0000 1234 on ${debitOn}.`) + nl();
  h += at(60, 'Next closing date 29/10/2026') + nl(10);
  h += at(15, 'For further information regarding the transactions listed on this statement: Worldline Financial Services (Europe) S.A., Service Clients, L-2956 Luxembourg.') + nl();
  return page(h);
}

async function printPdf(name: string, body: string) {
  interface Chromium {
    launch(): Promise<{ newPage(): Promise<{ setContent(html: string): Promise<void>; pdf(o: object): Promise<Uint8Array> }>; close(): Promise<void> }>;
  }
  const mod = (await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')) as { chromium: Chromium };
  const browser = await mod.chromium.launch();
  const p = await browser.newPage();
  await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
  write(name, await p.pdf({ format: 'A4', printBackground: false, preferCSSPageSize: true }));
  await browser.close();
}

await printPdf('spuerkeess-joint-2026-09.pdf', spuerkeessHtml());
await printPdf('visa-john-2026-08.pdf', worldlineHtml(visaAug, '29/08/2026', '05/09/2026'));
await printPdf('visa-john-2026-09.pdf', worldlineHtml(visaSep, '29/09/2026', '07/10/2026'));
console.log(`Spuerkeess closing ${eu(spkClosing)}; Visa Aug ${eu(total(visaAug))}; Visa Sep ${eu(total(visaSep))}`);
