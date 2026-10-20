// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AccountType } from '../api/accounts.js';
import { IMPORT_LIMITS, type ImportBalance, type ImportTransaction } from '../api/imports.js';
import { minorUnitExponent } from '../money.js';
import { normalizeDescription, type RowProblem } from './mapping.js';
import { parseAmount, parseDate } from './values.js';

// OFX and QFX statements (#74, docs/design/imports.md §1). Files are parsed in the browser, like
// CSV. One tokenizer reads OFX 1.x SGML (leaf tags left unclosed), OFX 2.x XML, and QFX (OFX with
// Quicken's INTU.* tags, ignored). It makes one pass over the text, holds at most 32 elements
// open, keeps only what a statement needs, and expands no DTDs or entities beyond the five XML
// ones and numeric references. The full account number never leaves this file: a statement
// carries its last 4 digits and a key that's unique within the file.

export const OFX_LIMITS = {
  /** Files over this are refused before they're read (the wizard checks the size first). */
  bytes: 20 * 1024 * 1024,
  /** Elements open at once. Real statements nest about 8 deep. */
  depth: 32,
  /** Statements in one file; the same account may have several (one per period). */
  statements: 2_000,
  /** Characters kept of one value. OFX allows 255 at most; the rest is dropped. */
  value: 1_000,
} as const;

/** Why a file can't be read, and where. Never carries the file's data, only a line number. */
export class OfxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'OfxError';
  }
}

/** ACCTTYPE of a bank statement. Card statements have none. */
export type OfxAccountType = 'CHECKING' | 'SAVINGS' | 'MONEYMRKT' | 'CREDITLINE' | 'CD';
const ACCOUNT_TYPES = new Set<string>(['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CD']);

/** One STMTTRN, values as written (trimmed, entities decoded). */
export interface OfxTransaction {
  /** The line its <STMTTRN> is on. */
  line: number;
  fitId: string | null;
  type: string | null;
  /** DTPOSTED. */
  posted: string | null;
  /** TRNAMT. */
  amount: string | null;
  /** NAME, or PAYEE/NAME. */
  name: string | null;
  memo: string | null;
  checkNum: string | null;
}

export interface OfxStatement {
  /** The line its <STMTRS> or <CCSTMTRS> is on. */
  line: number;
  kind: 'bank' | 'card';
  /**
   * Unique within the file, and the same for every statement of one account: "checking-1234",
   * "card-5678", "savings-1234-2" when two accounts end the same way. Never the account number.
   */
  key: string;
  accountType: OfxAccountType | null;
  /** The last 4 digits of ACCTID, or null with fewer than 4. */
  mask: string | null;
  /** The bank, from the sign-on (FI/ORG and FI/FID). */
  org: string | null;
  fid: string | null;
  /** CURDEF. */
  currency: string | null;
  /** LEDGERBAL: BALAMT on DTASOF, as written. */
  ledgerBalance: { amount: string | null; asOf: string | null; line: number } | null;
  transactions: OfxTransaction[];
}

/** A statement the import doesn't read yet; bank and card statements in the file still import. */
export interface OfxUnsupported {
  kind: 'investment' | 'loan';
  line: number;
}

export interface OfxFile {
  /** From the header: "102", "220", … */
  version: string | null;
  /** Quicken's INTU.BID is there: a QFX file. */
  intuBid: boolean;
  statements: OfxStatement[];
  unsupported: OfxUnsupported[];
  problems: RowProblem[];
}

// ── Bytes to text ────────────────────────────────────────────────────────────────────────────

const HEAD = 4096;

/** Which decoder the header asks for. Latin-1 is decoded as windows-1252, as browsers do. */
function headerEncoding(head: string): 'utf-8' | 'windows-1252' {
  if (/^\s*OFXHEADER\s*:/i.test(head)) {
    // OFX 1.x: "ENCODING:USASCII" with "CHARSET:1252" (or ISO-8859-1, or NONE), or "ENCODING:UTF-8".
    const encoding = /^\s*ENCODING\s*:\s*([\w-]+)/im.exec(head)?.[1]?.toUpperCase();
    return encoding === 'UTF-8' || encoding === 'UTF8' ? 'utf-8' : 'windows-1252';
  }
  const label = /<\?xml[^>]{0,200}?encoding\s*=\s*["']([\w.-]{1,40})["']/i.exec(head)?.[1];
  if (label && /^(windows-1252|cp1252|iso-8859-1|iso8859-1|latin-?1|us-ascii)$/i.test(label)) {
    return 'windows-1252';
  }
  return 'utf-8';
}

/**
 * Decodes a file's bytes as its header says: OFX 1.x CHARSET/ENCODING, or the XML declaration's
 * encoding. UTF-8 that isn't valid UTF-8 (a bank that says one thing and writes another) is read
 * as windows-1252 instead, so accented names survive either way.
 */
export function decodeOfx(bytes: Uint8Array): string {
  if (bytes.length > OFX_LIMITS.bytes) throw new OfxError('The file is over 20 MB', 1);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, HEAD); i++) head += String.fromCharCode(bytes[i]!);
  if (!bom && headerEncoding(head) === 'windows-1252') {
    return new TextDecoder('windows-1252').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** The file starts like OFX or QFX: a 1.x header, an OFX processing instruction, or <OFX>. */
export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, HEAD).toUpperCase();
  return /^\uFEFF?\s*OFXHEADER\s*:/.test(head) || head.includes('<?OFX') || head.includes('<OFX>');
}

/** QFX when Quicken's INTU.BID is in it or the file is named .qfx; otherwise OFX. */
export function ofxFormat(file: OfxFile, filename: string): 'ofx' | 'qfx' {
  return file.intuBid || /\.qfx$/i.test(filename.trim()) ? 'qfx' : 'ofx';
}

// ── Tokenizer ────────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates the reader knows. They never hold text, so a stray character can't turn one into a
 * leaf, and one left open when its parent closes is a broken file (an SGML leaf left open is
 * fine: that's how OFX 1.x writes them).
 */
const AGGREGATES = new Set([
  'OFX',
  'SIGNONMSGSRSV1',
  'SONRS',
  'STATUS',
  'FI',
  'BANKMSGSRSV1',
  'STMTTRNRS',
  'STMTRS',
  'CREDITCARDMSGSRSV1',
  'CCSTMTTRNRS',
  'CCSTMTRS',
  'BANKACCTFROM',
  'CCACCTFROM',
  'BANKACCTTO',
  'CCACCTTO',
  'BANKTRANLIST',
  'STMTTRN',
  'PAYEE',
  'CURRENCY',
  'ORIGCURRENCY',
  'LEDGERBAL',
  'AVAILBAL',
  'BALLIST',
  'BAL',
  'INVSTMTMSGSRSV1',
  'INVSTMTTRNRS',
  'INVSTMTRS',
  'LOANMSGSRSV1',
  'LOANSTMTTRNRS',
  'LOANSTMTRS',
]);

const UNSUPPORTED: Record<string, OfxUnsupported['kind']> = {
  INVSTMTRS: 'investment',
  LOANSTMTRS: 'loan',
};

const LT = 0x3c;
const GT = 0x3e;
const NL = 0x0a;
const SLASH = 0x2f;

const isNameChar = (c: number) =>
  (c >= 0x41 && c <= 0x5a) || // A-Z
  (c >= 0x61 && c <= 0x7a) || // a-z
  (c >= 0x30 && c <= 0x39) || // 0-9
  c === 0x2e || // .
  c === 0x5f || // _
  c === 0x2d || // -
  c === 0x3a; // :

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The five XML entities and numeric references; anything else ("AT&T") stays as written. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let from = 0;
  for (let p = s.indexOf('&'); p >= 0; p = s.indexOf('&', p + 1)) {
    // The ";" must be close: looking further would make "&&&&…" quadratic.
    let end = -1;
    for (let q = p + 1; q < s.length && q <= p + 10; q++) {
      if (s[q] === ';') {
        end = q;
        break;
      }
    }
    if (end < 0) continue;
    const name = s.slice(p + 1, end);
    let ch = ENTITIES[name];
    if (ch === undefined && name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const digits = name.slice(hex ? 2 : 1);
      if (digits && (hex ? /^[0-9a-f]+$/i : /^\d+$/).test(digits)) {
        const cp = parseInt(digits, hex ? 16 : 10);
        if (cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) ch = String.fromCodePoint(cp);
      }
    }
    if (ch === undefined) continue;
    out += s.slice(from, p) + ch;
    from = end + 1;
    p = end;
  }
  return out + s.slice(from);
}

interface Open {
  name: string;
  line: number;
  /** Text inside it, before any child: an SGML or XML leaf's value. */
  text: string | null;
  children: boolean;
}

interface Events {
  start(name: string, line: number): void;
  /** `value` is the leaf's text, or null for an element with children. */
  end(name: string, line: number, value: string | null): void;
}

/** Splits the text into elements, calling `events` in document order. Linear in the text. */
function tokenize(text: string, events: Events): void {
  const stack: Open[] = [];
  const n = text.length;
  let line = 1;
  let i = 0;

  const finish = (e: Open) => events.end(e.name, e.line, e.children ? null : (e.text ?? '').trim());

  const open = (name: string, at: number) => {
    const top = stack.at(-1);
    // An SGML leaf ends where the next tag starts.
    if (top && top.text !== null && !top.children) finish(stack.pop()!);
    if (stack.length >= OFX_LIMITS.depth) throw new OfxError('Elements nest too deeply', at);
    const parent = stack.at(-1);
    if (parent) parent.children = true;
    stack.push({ name, line: at, text: null, children: false });
    events.start(name, at);
  };

  const close = (name: string, at: number) => {
    let k = stack.length - 1;
    while (k >= 0 && stack[k]!.name !== name) k--;
    if (k < 0) throw new OfxError('A closing tag has no opening tag', at);
    while (stack.length - 1 > k) {
      const e = stack.pop()!;
      // Leaves may be left open (SGML); aggregates may not.
      if (e.children && AGGREGATES.has(e.name)) {
        throw new OfxError('An element is closed out of order', at);
      }
      finish(e);
    }
    finish(stack.pop()!);
  };

  /** Text from `from` to `to`: kept as the open element's value if it can have one. */
  const addText = (from: number, to: number) => {
    const top = stack.at(-1);
    if (!top || top.children || AGGREGATES.has(top.name)) return;
    const have = top.text?.length ?? 0;
    if (have >= OFX_LIMITS.value) return;
    let p = from;
    if (top.text === null) {
      while (p < to && isSpace(text.charCodeAt(p))) p++;
      if (p === to) return;
    }
    top.text = (top.text ?? '') + text.slice(p, Math.min(to, p + OFX_LIMITS.value - have));
  };

  /** Skips to just past `marker`, counting lines; a file that ends first is cut short. */
  const skipPast = (marker: string, from: number, at: number) => {
    const end = text.indexOf(marker, from);
    if (end < 0) throw new OfxError('The file ends early', at);
    for (let j = i; j < end; j++) if (text.charCodeAt(j) === NL) line++;
    i = end + marker.length;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c !== LT) {
      let j = i;
      while (j < n && text.charCodeAt(j) !== LT) {
        if (text.charCodeAt(j) === NL) line++;
        j++;
      }
      addText(i, j);
      i = j;
      continue;
    }
    const at = line;
    const next = text.charCodeAt(i + 1);
    if (next === 0x21 /* ! */) {
      // A comment, or a DOCTYPE or other declaration: skipped, never expanded.
      if (text.startsWith('<!--', i)) skipPast('-->', i + 4, at);
      else skipPast('>', i + 2, at);
      continue;
    }
    if (next === 0x3f /* ? */) {
      // <?xml …?> and <?OFX …?>: the header, read separately.
      skipPast('?>', i + 2, at);
      continue;
    }
    const closing = next === SLASH;
    let j = closing ? i + 2 : i + 1;
    const nameStart = j;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    if (j === nameStart) {
      // A "<" that starts no tag is text.
      addText(i, i + 1);
      i++;
      continue;
    }
    const name = text.slice(nameStart, j).toUpperCase();
    // OFX has no attributes: anything else up to ">" is passed over.
    while (j < n && text.charCodeAt(j) !== GT) {
      if (text.charCodeAt(j) === NL) line++;
      j++;
    }
    if (j >= n) throw new OfxError('The file ends early', at);
    const empty = !closing && text.charCodeAt(j - 1) === SLASH;
    i = j + 1;
    if (closing) close(name, at);
    else {
      open(name, at);
      if (empty) close(name, at);
    }
  }

  // What's left open: SGML leaves are fine, an aggregate means the file was cut short.
  while (stack.length > 0) {
    const e = stack.pop()!;
    if (AGGREGATES.has(e.name)) throw new OfxError('The file ends early', line);
    finish(e);
  }
}

// ── Statements ───────────────────────────────────────────────────────────────────────────────

/** The header's version: "VERSION:102" (1.x) or <?OFX … VERSION="220"?> (2.x). */
function headerVersion(text: string): string | null {
  const head = text.slice(0, HEAD);
  const sgml = /^\uFEFF?\s*OFXHEADER\s*:/i.test(head) && /^\s*VERSION\s*:\s*(\d{1,4})/im.exec(head);
  if (sgml) return sgml[1]!;
  const pi = head.search(/<\?OFX\b/i);
  if (pi < 0) return null;
  const end = head.indexOf('?>', pi);
  const body = head.slice(pi, end < 0 ? undefined : end);
  return /\bVERSION\s*=\s*["'](\d{1,4})["']/i.exec(body)?.[1] ?? null;
}

const lastFourDigits = (id: string): string | null => {
  let digits = '';
  for (let k = id.length - 1; k >= 0 && digits.length < 4; k--) {
    const ch = id[k]!;
    if (ch >= '0' && ch <= '9') digits = ch + digits;
  }
  return digits.length === 4 ? digits : null;
};

interface StatementDraft {
  line: number;
  kind: 'bank' | 'card';
  /** Only to tell accounts apart and find the last 4: never returned. */
  accountId: string | null;
  bankId: string | null;
  accountType: OfxAccountType | null;
  currency: string | null;
  ledgerBalance: OfxStatement['ledgerBalance'];
  transactions: OfxTransaction[];
}

/**
 * Reads an OFX or QFX file's bank and card statements. Throws OfxError, with a line number, for a
 * file that isn't OFX or can't be read as a whole (cut short, badly nested, over the limits);
 * statements it doesn't read yet are listed in `unsupported`.
 */
export function parseOfx(input: string): OfxFile {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.length > OFX_LIMITS.bytes) throw new OfxError('The file is over 20 MB', 1);
  if (!looksLikeOfx(text)) throw new OfxError('This isn’t an OFX file', 1);

  const file: OfxFile = {
    version: headerVersion(text),
    intuBid: false,
    statements: [],
    unsupported: [],
    problems: [],
  };
  // The aggregates open now, innermost last: where a leaf's value goes.
  const path: string[] = [];
  let sawOfx = false;
  let org: string | null = null;
  let fid: string | null = null;
  let statement: StatementDraft | null = null;
  let txn: OfxTransaction | null = null;
  let inUnsupported = 0;
  let transactionCount = 0;
  // Account → key, so a second statement for the same account gets the same key.
  const keys = new Map<string, string>();
  const usedKeys = new Set<string>();

  const finishStatement = (s: StatementDraft) => {
    const mask = s.accountId ? lastFourDigits(s.accountId) : null;
    const identity = [s.kind, s.bankId ?? '', s.accountId ?? `#${file.statements.length}`].join(
      '\u0000',
    );
    let key = keys.get(identity);
    if (!key) {
      if (keys.size >= IMPORT_LIMITS.accounts) {
        throw new OfxError(`More than ${IMPORT_LIMITS.accounts} accounts`, s.line);
      }
      const base = `${s.kind === 'card' ? 'card' : (s.accountType ?? 'bank').toLowerCase()}-${mask ?? 'account'}`;
      key = base;
      for (let k = 2; usedKeys.has(key); k++) key = `${base}-${k}`;
      keys.set(identity, key);
      usedKeys.add(key);
    }
    if (!s.accountId) {
      file.problems.push({ line: s.line, message: 'A statement has no account number' });
    }
    file.statements.push({
      line: s.line,
      kind: s.kind,
      key,
      accountType: s.accountType,
      mask,
      org,
      fid,
      currency: s.currency,
      ledgerBalance: s.ledgerBalance,
      transactions: s.transactions,
    });
  };

  tokenize(text, {
    start(name, line) {
      if (AGGREGATES.has(name)) path.push(name);
      if (name === 'OFX') sawOfx = true;
      if (UNSUPPORTED[name]) {
        if (!inUnsupported) file.unsupported.push({ kind: UNSUPPORTED[name], line });
        inUnsupported++;
      }
      if (inUnsupported) return;
      if (name === 'STMTRS' || name === 'CCSTMTRS') {
        if (statement) throw new OfxError('A statement starts inside another', line);
        if (file.statements.length >= OFX_LIMITS.statements) {
          throw new OfxError(`More than ${OFX_LIMITS.statements} statements`, line);
        }
        statement = {
          line,
          kind: name === 'STMTRS' ? 'bank' : 'card',
          accountId: null,
          bankId: null,
          accountType: null,
          currency: null,
          ledgerBalance: null,
          transactions: [],
        };
      } else if (name === 'STMTTRN' && statement && path.at(-2) === 'BANKTRANLIST') {
        if (++transactionCount > IMPORT_LIMITS.transactions) {
          throw new OfxError(
            `More than ${IMPORT_LIMITS.transactions.toLocaleString('en-US')} transactions`,
            line,
          );
        }
        txn = {
          line,
          fitId: null,
          type: null,
          posted: null,
          amount: null,
          name: null,
          memo: null,
          checkNum: null,
        };
      } else if (name === 'LEDGERBAL' && statement) {
        statement.ledgerBalance = { amount: null, asOf: null, line };
      }
    },

    end(name, _line, value) {
      if (name === 'INTU.BID') file.intuBid = true;
      if (AGGREGATES.has(name)) {
        path.pop();
        if (UNSUPPORTED[name]) inUnsupported--;
        else if (inUnsupported) return;
        else if (name === 'STMTTRN' && txn && statement) {
          statement.transactions.push(txn);
          txn = null;
        } else if ((name === 'STMTRS' || name === 'CCSTMTRS') && statement) {
          finishStatement(statement);
          statement = null;
        }
        return;
      }
      if (inUnsupported || value === null) return;
      const v = decodeEntities(value).trim() || null;
      const at = path.at(-1);
      if (at === 'FI') {
        if (name === 'ORG') org = v;
        else if (name === 'FID') fid = v;
      } else if (!statement) {
        return;
      } else if (at === 'STMTRS' || at === 'CCSTMTRS') {
        if (name === 'CURDEF')
          statement.currency = v && /^[A-Z]{3}$/i.test(v) ? v.toUpperCase() : null;
      } else if (at === 'BANKACCTFROM' || at === 'CCACCTFROM') {
        if (name === 'ACCTID') statement.accountId = v;
        else if (name === 'BANKID') statement.bankId = v;
        else if (name === 'ACCTTYPE') {
          const t = v?.toUpperCase() ?? '';
          statement.accountType = ACCOUNT_TYPES.has(t) ? (t as OfxAccountType) : null;
        }
      } else if (at === 'LEDGERBAL' && statement.ledgerBalance) {
        if (name === 'BALAMT') statement.ledgerBalance.amount = v;
        else if (name === 'DTASOF') statement.ledgerBalance.asOf = v;
      } else if (at === 'STMTTRN' && txn) {
        if (name === 'FITID') txn.fitId = v;
        else if (name === 'TRNTYPE') txn.type = v?.toUpperCase() ?? null;
        else if (name === 'DTPOSTED') txn.posted = v;
        else if (name === 'TRNAMT') txn.amount = v;
        else if (name === 'NAME') txn.name = v ?? txn.name;
        else if (name === 'MEMO') txn.memo = v;
        else if (name === 'CHECKNUM') txn.checkNum = v;
      } else if (at === 'PAYEE' && path.at(-2) === 'STMTTRN' && txn && name === 'NAME') {
        // A NAME of its own wins; PAYEE/NAME is the fallback.
        txn.name ??= v;
      }
    },
  });

  if (!sawOfx) throw new OfxError('This isn’t an OFX file', 1);
  return file;
}

// ── Import rows ──────────────────────────────────────────────────────────────────────────────

/** "20261006", "20261006120000.000[-5:EST]": the first 8 digits as written, time and zone ignored. */
export function parseOfxDate(raw: string | null): string | null {
  const s = raw?.trim() ?? '';
  if (s.length < 8) return null;
  for (let k = 0; k < 8; k++) if (s[k]! < '0' || s[k]! > '9') return null;
  return parseDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, 'ymd');
}

/** TRNAMT or BALAMT to minor units, sign kept. OFX allows a comma as the decimal point. */
export function parseOfxAmount(raw: string | null, exponent: number): number | null {
  const s = raw?.trim() ?? '';
  if (!s) return null;
  return parseAmount(s, s.includes(',') && !s.includes('.') ? ',' : '.', exponent);
}

const oneLine = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * NAME (or PAYEE/NAME), plus MEMO when it adds text; "Check 1043" when there's no name. It becomes
 * the bank's text: `name` is never set, so cleanup and rules still apply.
 */
export function ofxDescription(t: OfxTransaction): string {
  const name = oneLine(t.name);
  const memo = oneLine(t.memo);
  const check = oneLine(t.checkNum);
  const base = name || (check ? `Check ${check}` : '');
  const adds = memo && !normalizeDescription(base).includes(normalizeDescription(memo));
  return (adds ? (base ? `${base} ${memo}` : memo) : base).slice(0, 500);
}

/** Types that are money out, and money in, whatever the bank's sign. */
const MONEY_OUT = new Set(['DEBIT', 'CHECK', 'ATM', 'POS', 'FEE', 'SRVCHG', 'DIRECTDEBIT']);
const MONEY_IN = new Set(['CREDIT', 'DEP', 'DIRECTDEP', 'INT', 'DIV']);

/** What the wizard shows about each account in the file. */
export interface OfxAccount {
  key: string;
  kind: 'bank' | 'card';
  ofxType: OfxAccountType | null;
  suggestedType: AccountType;
  /** The last 4 digits, to match an account you have or to set on a new one. */
  mask: string | null;
  org: string | null;
  fid: string | null;
  /** CURDEF; a new account gets it. */
  currency: string | null;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
  /** LEDGERBAL of its latest statement: one entered balance, on its day. */
  ledgerBalance: { date: string; balanceMinor: number } | null;
  /**
   * Spending looks like money in (DEBIT rows positive, say): the wizard offers to reverse the
   * signs. TRNAMT is trusted otherwise.
   */
  amountsLookReversed: boolean;
  /** The line of its first statement. */
  line: number;
}

export interface OfxImport {
  transactions: ImportTransaction[];
  balances: ImportBalance[];
  accounts: OfxAccount[];
  unsupported: OfxUnsupported[];
  problems: RowProblem[];
}

const exponentOf = (currency: string) => {
  try {
    return minorUnitExponent(currency);
  } catch {
    return 2;
  }
};

/**
 * Turns parsed statements into import rows and a balance per account. `currency` (the
 * household's) sets the decimals for a statement without CURDEF. Rows that can't be read are
 * reported by line and left out.
 */
export function readOfx(file: OfxFile, options: { currency: string }): OfxImport {
  const transactions: ImportTransaction[] = [];
  const balances = new Map<string, ImportBalance>();
  const accounts = new Map<string, OfxAccount>();
  const problems: RowProblem[] = [...file.problems];
  const signs = new Map<
    string,
    { agree: number; disagree: number; positive: number; negative: number }
  >();

  for (const s of file.statements) {
    const exponent = exponentOf(s.currency ?? options.currency);
    let a = accounts.get(s.key);
    if (!a) {
      a = {
        key: s.key,
        kind: s.kind,
        ofxType: s.accountType,
        suggestedType:
          s.kind === 'card' || s.accountType === 'CREDITLINE' ? 'credit' : 'depository',
        mask: s.mask,
        org: s.org,
        fid: s.fid,
        currency: s.currency,
        transactions: 0,
        firstDate: null,
        lastDate: null,
        ledgerBalance: null,
        amountsLookReversed: false,
        line: s.line,
      };
      accounts.set(s.key, a);
      signs.set(s.key, { agree: 0, disagree: 0, positive: 0, negative: 0 });
    }
    const sign = signs.get(s.key)!;

    for (const t of s.transactions) {
      const date = parseOfxDate(t.posted);
      if (!date) {
        problems.push({ line: t.line, message: 'The posted date isn’t a date' });
        continue;
      }
      const amountMinor = parseOfxAmount(t.amount, exponent);
      if (amountMinor === null) {
        problems.push({ line: t.line, message: 'The amount isn’t a number' });
        continue;
      }
      const fitId = t.fitId?.trim();
      transactions.push({
        line: t.line,
        account: s.key,
        date,
        amountMinor,
        description: ofxDescription(t),
        // A longer id than OFX allows would have to be cut, and could then match another's.
        ...(fitId && fitId.length <= 255 ? { externalId: fitId } : {}),
      });
      a.transactions++;
      if (!a.firstDate || date < a.firstDate) a.firstDate = date;
      if (!a.lastDate || date > a.lastDate) a.lastDate = date;
      if (amountMinor > 0) sign.positive++;
      if (amountMinor < 0) sign.negative++;
      const out = t.type !== null && MONEY_OUT.has(t.type);
      const into = t.type !== null && MONEY_IN.has(t.type);
      if ((out && amountMinor < 0) || (into && amountMinor > 0)) sign.agree++;
      if ((out && amountMinor > 0) || (into && amountMinor < 0)) sign.disagree++;
    }

    const lb = s.ledgerBalance;
    if (lb) {
      const date = parseOfxDate(lb.asOf);
      const balanceMinor = parseOfxAmount(lb.amount, exponent);
      if (!date) problems.push({ line: lb.line, message: 'The balance date isn’t a date' });
      else if (balanceMinor === null) {
        problems.push({ line: lb.line, message: 'The balance isn’t a number' });
      } else if (!a.ledgerBalance || date >= a.ledgerBalance.date) {
        // Several statements for one account: the latest balance is the one entered.
        a.ledgerBalance = { date, balanceMinor };
        balances.set(s.key, { account: s.key, date, balanceMinor });
      }
    }
  }

  for (const a of accounts.values()) {
    const s = signs.get(a.key)!;
    // With no typed rows to go by, a card whose rows are mostly money in looks reversed:
    // purchases are money out.
    a.amountsLookReversed =
      s.agree + s.disagree > 0
        ? s.disagree > s.agree
        : a.kind === 'card' && s.positive > s.negative;
  }

  return {
    transactions,
    balances: [...balances.values()],
    accounts: [...accounts.values()],
    unsupported: file.unsupported,
    problems: problems.sort((x, y) => x.line - y.line),
  };
}
