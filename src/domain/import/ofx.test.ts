import { describe, expect, it } from 'vitest';
import { detectAndParse } from './detect';
import { isOfx, ofxDate, parseOfx } from './ofx';

// Synthetic statements (fictional accounts and merchants).
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260930</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS>
<CURDEF>EUR
<BANKACCTFROM><BANKID>EXAMPLE<ACCTID>LU000000000000001234<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901
<DTEND>20260930
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260903120000.000[+2:CEST]
<TRNAMT>-84.37
<FITID>A1
<NAME>CACTUS HOWALD
<MEMO>Card payment
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260925
<DTAVAIL>20260926
<TRNAMT>3400.00
<FITID>A2
<NAME>EXAMPLE EMPLOYER S.A.
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260928
<TRNAMT>-45.50
<FITID>A3
<NAME>BOOKSHOP &amp; CO
<ORIGCURRENCY><CURRATE>0.91<CURSYM>GBP</ORIGCURRENCY>
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260929
<TRNAMT>0.00
<FITID>A4
<NAME>CARD CHECK
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>5270.13<DTASOF>20260930</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX>
  <CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
    <CURDEF>EUR</CURDEF>
    <CCACCTFROM><ACCTID>XXXXXXXXXXXX4321</ACCTID></CCACCTFROM>
    <BANKTRANLIST>
      <DTSTART>20260801</DTSTART><DTEND>20260831</DTEND>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260812</DTPOSTED><TRNAMT>-120,00</TRNAMT><FITID>B1</FITID>
        <PAYEE><NAME>HOTEL EXAMPLE</NAME></PAYEE>
        <CURRENCY><CURRATE>0.92</CURRATE><CURSYM>USD</CURSYM></CURRENCY>
      </STMTTRN>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260815</DTPOSTED><TRNAMT>-9.99</TRNAMT><FITID>B2</FITID><NAME>STREAMING</NAME></STMTTRN>
    </BANKTRANLIST>
    <LEDGERBAL><BALAMT>-120.39</BALAMT><DTASOF>20260901</DTASOF></LEDGERBAL>
  </CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

describe('OFX import', () => {
  it('reads OFX 1.x SGML: rows, dates, entities, original currency, balance', () => {
    expect(isOfx(SGML)).toBe(true);
    expect(ofxDate('20260903120000.000[+2:CEST]')).toBe('2026-09-03');
    const r = parseOfx(SGML);
    expect(r.format).toBe('ofx');
    expect(r.rows.map((x) => [x.date, x.amount, x.description])).toEqual([
      ['2026-09-03', -8437, 'CACTUS HOWALD'],
      ['2026-09-25', 340000, 'EXAMPLE EMPLOYER S.A.'],
      ['2026-09-28', -4550, 'BOOKSHOP & CO'],
    ]);
    expect(r.rows[0]).toMatchObject({ details: 'Card payment', counterparty: 'CACTUS HOWALD', accountKey: '1234' });
    expect(r.rows[1]!.valueDate).toBe('2026-09-26');
    expect(r.rows[2]).toMatchObject({ originalCurrency: 'GBP', originalAmount: -5000 });
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'zero' })]);
    expect(r.statements).toEqual([{ accountKey: '1234', last4: '1234', periodStart: '2026-09-01', periodEnd: '2026-09-30', closingBalance: 527013 }]);
  });

  it('reads OFX 2.x XML card statements, payee blocks, comma decimals and foreign amounts', () => {
    const r = parseOfx(XML);
    expect(r.rows.map((x) => [x.date, x.amount, x.description, x.originalCurrency, x.originalAmount])).toEqual([
      ['2026-08-12', -11040, 'HOTEL EXAMPLE', 'USD', -12000],
      ['2026-08-15', -999, 'STREAMING', undefined, undefined],
    ]);
    expect(r.statements[0]).toMatchObject({ accountKey: '4321', last4: '4321', periodEnd: '2026-09-01', closingBalance: -12039 });
  });

  it('is detected by content or by .ofx/.qfx name', () => {
    const d = detectAndParse({ kind: 'text', name: 'export.qfx', text: SGML }, [], () => {
      throw new Error('no xml');
    });
    expect(d.kind === 'parsed' && d.result.rows.length).toBe(3);
    const x = detectAndParse({ kind: 'text', name: 'card.xml', text: XML }, [], () => {
      throw new Error('no xml');
    });
    expect(x.kind === 'parsed' && x.result.format).toBe('ofx');
  });
});
