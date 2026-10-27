// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeOfx,
  looksLikeOfx,
  OFX_LIMITS,
  OfxError,
  ofxDescription,
  ofxFormat,
  parseOfx,
  parseOfxAmount,
  parseOfxDate,
  readOfx,
} from './ofx.js';

// Every fixture is synthetic: made up for these tests, never a real statement.
const bytes = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const fixture = (name: string) => decodeOfx(bytes(name));
const read = (text: string) => readOfx(parseOfx(text), { currency: 'USD' });

/** The error a parse throws, for its message and line. */
const failure = (text: string): OfxError => {
  try {
    parseOfx(text);
  } catch (e) {
    if (e instanceof OfxError) return e;
    throw e;
  }
  throw new Error('parsed');
};

const HEADER = 'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\n\r\n';
const sgml = (body: string) => `${HEADER}<OFX>\n${body}\n</OFX>\n`;
const bankStatement = (acctId: string, type: string, transactions: string, balance = '') =>
  `<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>1<ACCTID>${acctId}<ACCTTYPE>${type}</BANKACCTFROM>
<BANKTRANLIST>${transactions}</BANKTRANLIST>${balance}
</STMTRS></STMTTRNRS></BANKMSGSRSV1>`;
const trn = (fitId: string, date: string, amount: string, name: string, extra = '') =>
  `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitId}<NAME>${name}${extra}</STMTTRN>\n`;

describe('reading OFX and QFX files', () => {
  const expected = [
    {
      date: '2026-09-15',
      amountMinor: -450,
      description: 'Café Façade Joe’s “latte”',
      externalId: '202609150001',
    },
    {
      date: '2026-10-01',
      amountMinor: -2310,
      description: 'AT&T WIRELESS Bill pay',
      externalId: '202610010001',
    },
    {
      date: '2026-10-06',
      amountMinor: -125000,
      description: 'Check 1043',
      externalId: '202610060001',
    },
    {
      date: '2026-10-06',
      amountMinor: 250000,
      description: 'PAYROLL EXAMPLE CO',
      externalId: '202610060002',
    },
  ];

  it('reads OFX 1.x SGML (windows-1252), 2.x XML, and QFX to the same rows', () => {
    for (const name of ['bank-sgml-1252.ofx', 'bank-xml.ofx', 'bank.qfx']) {
      const r = read(fixture(name));
      expect(
        r.transactions.map(({ line: _, ...t }) => t),
        name,
      ).toEqual(expected.map((t) => ({ ...t, account: 'checking-1234' })));
      expect(r.balances, name).toEqual([
        { account: 'checking-1234', date: '2026-10-06', balanceMinor: 322240 },
      ]);
      expect(r.accounts, name).toMatchObject([
        {
          key: 'checking-1234',
          kind: 'bank',
          ofxType: 'CHECKING',
          suggestedType: 'depository',
          mask: '1234',
          org: 'Example Credit Union',
          fid: '99999',
          currency: 'USD',
          transactions: 4,
          firstDate: '2026-09-15',
          lastDate: '2026-10-06',
          ledgerBalance: { date: '2026-10-06', balanceMinor: 322240 },
          amountsLookReversed: false,
        },
      ]);
      expect(r.problems, name).toEqual([]);
      expect(r.unsupported, name).toEqual([]);
    }
    // Lines point at each <STMTTRN>.
    expect(read(fixture('bank-sgml-1252.ofx')).transactions.map((t) => t.line)).toEqual([
      43, 51, 59, 66,
    ]);
    expect(parseOfx(fixture('bank-sgml-1252.ofx')).version).toBe('102');
    expect(parseOfx(fixture('bank-xml.ofx')).version).toBe('220');
  });

  it('never sets a name, so cleanup and rules still apply', () => {
    for (const t of read(fixture('bank-xml.ofx')).transactions)
      expect(t).not.toHaveProperty('name');
  });

  it('calls a file with INTU.BID or a .qfx name QFX', () => {
    expect(ofxFormat(parseOfx(fixture('bank.qfx')), 'download.ofx')).toBe('qfx');
    expect(ofxFormat(parseOfx(fixture('card.qfx')), 'card.QFX')).toBe('qfx');
    expect(ofxFormat(parseOfx(fixture('bank-sgml-1252.ofx')), 'bank.ofx')).toBe('ofx');
    expect(ofxFormat(parseOfx(fixture('bank-sgml-1252.ofx')), 'bank.qfx')).toBe('qfx');
  });

  it('recognizes OFX by content', () => {
    expect(looksLikeOfx(fixture('bank-sgml-1252.ofx'))).toBe(true);
    expect(looksLikeOfx(fixture('bank-xml.ofx'))).toBe(true);
    expect(looksLikeOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')).toBe(true);
    expect(looksLikeOfx(fixture('not-ofx.ofx'))).toBe(false);
    expect(looksLikeOfx('Date,Description,Amount\n')).toBe(false);
  });

  it('lists each account in a file with checking, savings, and a card', () => {
    const r = read(fixture('multi-account.ofx'));
    expect(
      r.accounts.map((a) => [a.key, a.kind, a.ofxType, a.suggestedType, a.mask, a.currency]),
    ).toEqual([
      ['checking-1234', 'bank', 'CHECKING', 'depository', '1234', 'USD'],
      ['savings-5678', 'bank', 'SAVINGS', 'depository', '5678', 'USD'],
      ['card-9012', 'card', null, 'credit', '9012', 'USD'],
    ]);
    expect(r.balances).toEqual([
      { account: 'checking-1234', date: '2026-10-06', balanceMinor: 143825 },
      { account: 'savings-5678', date: '2026-10-06', balanceMinor: 550123 },
      { account: 'card-9012', date: '2026-10-06', balanceMinor: -3840 },
    ]);
    expect(r.transactions.map((t) => [t.account, t.amountMinor])).toEqual([
      ['checking-1234', -50000],
      ['checking-1234', -6175],
      ['savings-5678', 50000],
      ['savings-5678', 123],
      ['card-9012', -3840],
    ]);
  });

  it('never keeps or returns the full account number', () => {
    const numbers = ['000111221234', '000555661234', '000555665678', '4000000000009012'];
    for (const name of ['bank-sgml-1252.ofx', 'bank-xml.ofx', 'multi-account.ofx', 'card.qfx']) {
      const parsed = parseOfx(fixture(name));
      const out = JSON.stringify([parsed, readOfx(parsed, { currency: 'USD' })]);
      for (const n of numbers) expect(out, name).not.toContain(n);
      // Nor the routing number.
      expect(out, name).not.toContain('999999999');
      expect(out, name).not.toContain('888888888');
    }
  });

  it('imports bank statements beside investment and loan statements it can’t read yet', () => {
    const r = read(fixture('investment-and-bank.ofx'));
    expect(r.unsupported).toEqual([
      { kind: 'investment', line: 33 },
      { kind: 'loan', line: 96 },
    ]);
    // The cash deposit inside the investment statement isn't imported.
    expect(r.transactions.map(({ line: _, ...t }) => t)).toEqual([
      {
        account: 'moneymrkt-3456',
        date: '2026-09-30',
        amountMinor: 1234,
        description: 'DIVIDEND',
        externalId: 'MM-0930-1',
      },
    ]);
    expect(r.accounts.map((a) => [a.key, a.org])).toEqual([
      ['moneymrkt-3456', 'Example Brokerage'],
    ]);
  });

  it('keeps every row of a FITID the bank repeated: the api tells them apart', () => {
    const r = read(fixture('duplicate-fitid.ofx'));
    expect(r.transactions.map((t) => [t.externalId, t.date, t.amountMinor])).toEqual([
      ['1001', '2026-09-10', -1000],
      ['1001', '2026-09-12', -4200],
      ['1001', '2026-09-10', -1000],
      ['1002', '2026-09-14', -725],
    ]);
  });

  it('trusts TRNAMT, and notices when spending looks like money in', () => {
    const card = read(fixture('card.qfx'));
    expect(card.transactions.map((t) => t.amountMinor)).toEqual([-5420, 30000, -1299]);
    expect(card.accounts[0]).toMatchObject({
      kind: 'card',
      mask: '9012',
      amountsLookReversed: false,
    });
    const reversed = read(fixture('card-reversed.qfx'));
    expect(reversed.transactions.map((t) => t.amountMinor)).toEqual([5420, -30000, 1299]);
    expect(reversed.accounts[0]!.amountsLookReversed).toBe(true);
    // Untyped rows on a card: mostly money in looks reversed too.
    const untyped = read(
      sgml(
        `<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>5555</CCACCTFROM>
<BANKTRANLIST>${trn('a', '20260901', '10.00', 'A')}${trn('b', '20260902', '11.00', 'B')}</BANKTRANLIST>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>`,
      ),
    );
    expect(untyped.accounts[0]!.amountsLookReversed).toBe(true);
  });

  it('reads the date as written, ignoring the time and zone', () => {
    expect(parseOfxDate('20261006')).toBe('2026-10-06');
    expect(parseOfxDate('20261006120000.000[-5:EST]')).toBe('2026-10-06');
    expect(parseOfxDate('20261006000000[0:GMT]')).toBe('2026-10-06');
    expect(parseOfxDate('20261006235959[+12:NZST]')).toBe('2026-10-06');
    expect(parseOfxDate('2026-10-06')).toBeNull();
    expect(parseOfxDate('20261306')).toBeNull();
    expect(parseOfxDate('20260230')).toBeNull();
    expect(parseOfxDate(null)).toBeNull();
  });

  it('reads amounts to minor units without floats, with a point or a comma', () => {
    expect(parseOfxAmount('-1250.00', 2)).toBe(-125000);
    expect(parseOfxAmount('+5', 2)).toBe(500);
    expect(parseOfxAmount('-12,34', 2)).toBe(-1234);
    expect(parseOfxAmount('0.1', 2)).toBe(10);
    expect(parseOfxAmount('-4.5000', 2)).toBe(-450);
    expect(parseOfxAmount('1.005', 2)).toBeNull();
    expect(parseOfxAmount('1200', 0)).toBe(1200);
    expect(parseOfxAmount('90071992547409.93', 2)).toBeNull();
    expect(parseOfxAmount('', 2)).toBeNull();
    // CURDEF sets the decimals.
    const yen = read(
      sgml(
        bankStatement('1234', 'CHECKING', trn('y', '20260901', '-1200', 'RAMEN')).replace(
          'USD',
          'JPY',
        ),
      ),
    );
    expect(yen.transactions[0]!.amountMinor).toBe(-1200);
    expect(yen.accounts[0]!.currency).toBe('JPY');
  });

  it('describes a row by its name, its memo when it adds text, or its check number', () => {
    const t = {
      line: 1,
      fitId: null,
      type: null,
      posted: null,
      amount: null,
      name: null,
      memo: null,
      checkNum: null,
    };
    expect(ofxDescription({ ...t, name: 'GROCER', memo: 'grocer' })).toBe('GROCER');
    expect(ofxDescription({ ...t, name: 'POS PURCHASE', memo: 'CORNER  SHOP' })).toBe(
      'POS PURCHASE CORNER SHOP',
    );
    expect(ofxDescription({ ...t, memo: 'ONLINE TRANSFER' })).toBe('ONLINE TRANSFER');
    expect(ofxDescription({ ...t, checkNum: '1043' })).toBe('Check 1043');
    expect(ofxDescription({ ...t, checkNum: '1043', memo: 'Rent' })).toBe('Check 1043 Rent');
    expect(ofxDescription({ ...t, name: 'x'.repeat(600) })).toHaveLength(500);
  });

  it('reports rows it can’t read by line, without their data, and imports the rest', () => {
    const r = read(
      sgml(
        bankStatement(
          'AB-123',
          'SAVINGS',
          trn('1', 'yesterday', '-5.00', 'SECRET SHOP') +
            trn('2', '20260901', 'lots', 'SECRET SHOP') +
            trn('3', '20260902', '-1.00', 'FINE'),
          '<LEDGERBAL><BALAMT>12.3.4<DTASOF>20261006</LEDGERBAL>',
        ),
      ),
    );
    expect(r.transactions.map((t) => t.description)).toEqual(['FINE']);
    expect(r.problems).toEqual([
      { line: 8, message: 'The posted date isn’t a date' },
      { line: 9, message: 'The amount isn’t a number' },
      { line: 11, message: 'The balance isn’t a number' },
    ]);
    // Fewer than 4 digits: no mask.
    expect(r.accounts[0]).toMatchObject({ key: 'savings-account', mask: null });
    expect(JSON.stringify(r.problems)).not.toMatch(/SECRET|yesterday|lots|12\.3/);
  });

  it('keeps one key per account, and tells apart accounts that end the same', () => {
    const r = read(
      sgml(
        bankStatement(
          '1111-0000-1234',
          'CHECKING',
          trn('a', '20260901', '-1', 'A'),
          '<LEDGERBAL><BALAMT>10<DTASOF>20260901</LEDGERBAL>',
        ) +
          bankStatement('2222-0000-1234', 'CHECKING', trn('b', '20260902', '-2', 'B')) +
          bankStatement(
            '1111-0000-1234',
            'CHECKING',
            trn('c', '20261001', '-3', 'C'),
            '<LEDGERBAL><BALAMT>7<DTASOF>20261001</LEDGERBAL>',
          ),
      ),
    );
    expect(r.transactions.map((t) => [t.account, t.externalId])).toEqual([
      ['checking-1234', 'a'],
      ['checking-1234-2', 'b'],
      ['checking-1234', 'c'],
    ]);
    expect(r.accounts.map((a) => [a.key, a.transactions])).toEqual([
      ['checking-1234', 2],
      ['checking-1234-2', 1],
    ]);
    // The latest statement's balance is the one entered.
    expect(r.balances).toEqual([
      { account: 'checking-1234', date: '2026-10-01', balanceMinor: 700 },
    ]);
  });

  it('reads SGML leaves left open, XML entities, comments, and PAYEE names', () => {
    const r = read(
      sgml(
        bankStatement(
          '9876',
          'checking',
          `<!-- a comment with <STMTTRN> inside -->
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260901<TRNAMT>-1.00<FITID>e1<NAME>A &lt;B&gt; &quot;C&quot; &#39;D&#39; &#x2014; AT&T &bogus; &#xD800;</NAME><MEMO></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902<TRNAMT>-2.00<FITID>e2<PAYEE><NAME>PAYEE NAME<CITY>X</PAYEE></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-3.00<FITID>e3<MEMO><NAME>AFTER EMPTY MEMO</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260904<TRNAMT>-4.00<FITID/><NAME>1 < 2</STMTTRN>`,
        ),
      ),
    );
    expect(r.transactions.map((t) => [t.description, t.externalId ?? null])).toEqual([
      ['A <B> "C" \'D\' — AT&T &bogus; &#xD800;', 'e1'],
      ['PAYEE NAME', 'e2'],
      ['AFTER EMPTY MEMO', 'e3'],
      ['1 < 2', null],
    ]);
    expect(r.accounts[0]!.ofxType).toBe('CHECKING');
  });

  it('decodes as the header says, and falls back when a file isn’t the UTF-8 it claims', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const latin = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
    expect(
      decodeOfx(latin('OFXHEADER:100\nCHARSET:1252\n\n<OFX><NAME>Caf\xe9 \x93x\x94')),
    ).toContain('Café “x”');
    expect(decodeOfx(enc('OFXHEADER:100\nENCODING:UTF-8\n\n<OFX><NAME>Café'))).toContain('Café');
    expect(decodeOfx(enc('<?xml version="1.0" encoding="utf-8"?><OFX>Café'))).toContain('Café');
    expect(decodeOfx(latin('<?xml version="1.0" encoding="ISO-8859-1"?><OFX>Caf\xe9'))).toContain(
      'Café',
    );
    // Says UTF-8, is windows-1252.
    expect(decodeOfx(latin('<?xml version="1.0" encoding="UTF-8"?><OFX>Caf\xe9'))).toContain(
      'Café',
    );
    // A byte-order mark wins, and is dropped.
    expect(decodeOfx(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('<OFX>é')]))).toBe('<OFX>é');
  });

  it('refuses files it can’t read, with the line, and none of their data', () => {
    const truncated = failure(fixture('malformed-truncated.ofx'));
    expect([truncated.message, truncated.line]).toEqual(['The file ends early', 39]);
    const nesting = failure(fixture('malformed-nesting.ofx'));
    expect([nesting.message, nesting.line]).toEqual(['An element is closed out of order', 19]);
    const notOfx = failure(fixture('not-ofx.ofx'));
    expect([notOfx.message, notOfx.line]).toEqual(['This isn’t an OFX file', 1]);
    expect(failure(sgml('</STMTRS>')).message).toBe('A closing tag has no opening tag');
    expect(failure(`${HEADER}<OFX><SIGNONMSGSRSV1><SONRS`).message).toBe('The file ends early');
    expect(failure(`${HEADER}<OFX><!-- never closed`).message).toBe('The file ends early');
    expect(failure(`${HEADER}<HTML></HTML>`).message).toBe('This isn’t an OFX file');
    expect(failure(sgml('<STMTRS><STMTRS></STMTRS></STMTRS>')).message).toBe(
      'A statement starts inside another',
    );
    for (const e of [truncated, nesting, notOfx]) expect(e.message).not.toMatch(/COFFEE|\d{6}/);
  });

  it('refuses a file with too many transactions or accounts', () => {
    const many = sgml(
      bankStatement(
        '1234',
        'CHECKING',
        Array.from({ length: 50_001 }, (_, i) => trn(String(i), '20260901', '-1', 'X')).join(''),
      ),
    );
    expect(failure(many).message).toBe('More than 50,000 transactions');
    const accounts = sgml(
      Array.from({ length: 201 }, (_, i) => bankStatement(`ACCT${i}`, 'CHECKING', '')).join(''),
    );
    expect(failure(accounts).message).toBe('More than 200 accounts');
  });
});

describe('pathological OFX', () => {
  // Each finishes in a second or two on a laptop. Linear time, not fast time: a quadratic parser
  // would take hours on 20 MB, so a bound of a minute still catches one, and a busy CI runner
  // (16 s for the noise file on #449) doesn't fail it.
  const quick = <T>(fn: () => T): T => {
    const start = performance.now();
    const out = fn();
    expect(performance.now() - start).toBeLessThan(60_000);
    return out;
  };
  const SLOW = 120_000;
  const near20MB = OFX_LIMITS.bytes - 1024;

  it(
    'stops at 32 elements deep',
    () => {
      const deep = `${HEADER}<OFX>${'<A>'.repeat(1_000_000)}`;
      const e = quick(() => failure(deep));
      expect(e.message).toBe('Elements nest too deeply');
    },
    SLOW,
  );

  it(
    'refuses a file over 20 MB before reading it',
    () => {
      const big = new Uint8Array(OFX_LIMITS.bytes + 1);
      expect(() => decodeOfx(big)).toThrow('The file is over 20 MB');
      expect(failure(`${HEADER}<OFX>${' '.repeat(OFX_LIMITS.bytes)}`).message).toBe(
        'The file is over 20 MB',
      );
    },
    SLOW,
  );

  // One test per input, so each gets its own time.
  it.each([
    [
      'a sea of "<" that start no tag',
      () => `${HEADER}<OFX>${'<'.repeat(near20MB)}`,
      'The file ends early',
    ],
    [
      'one tag that never ends',
      () => `${HEADER}<OFX><${'A'.repeat(near20MB)}`,
      'The file ends early',
    ],
    [
      'a comment that never ends',
      () => `${HEADER}<OFX><!--${'-'.repeat(near20MB)}`,
      'The file ends early',
    ],
    [
      'a processing instruction that never ends',
      () => `${HEADER}<OFX><?${'?'.repeat(near20MB)}`,
      'The file ends early',
    ],
    [
      'ampersands with no ";" in one enormous value',
      () => `${HEADER}<OFX><NAME>${'&'.repeat(near20MB)}`,
      'The file ends early',
    ],
    [
      'closing tags for nothing',
      () => `${HEADER}<OFX>${'</A>'.repeat(near20MB / 4)}`,
      'A closing tag has no opening tag',
    ],
  ])(
    'reads 20 MB of %s in linear time and fails cleanly',
    (_, text, message) => {
      expect(quick(() => failure(text())).message).toBe(message);
    },
    SLOW,
  );

  it(
    'reads a well-formed 20 MB file of noise to nothing',
    () => {
      const noise = `${HEADER}<OFX>${'<X>a&amp;b</X><Y/>\n'.repeat(near20MB / 20)}</OFX>`;
      const file = quick(() => parseOfx(noise));
      expect(file.statements).toEqual([]);
    },
    SLOW,
  );

  it(
    'keeps a huge value to a bounded length',
    () => {
      const r = quick(() =>
        read(
          sgml(
            bankStatement(
              '1234',
              'CHECKING',
              trn('1', '20260901', '-1', 'N'.repeat(near20MB - 500)),
            ),
          ),
        ),
      );
      expect(r.transactions[0]!.description).toHaveLength(500);
    },
    SLOW,
  );
});
