// SPDX-License-Identifier: AGPL-3.0-or-later
// CSV reading for imports (docs/design/imports.md §1). Files are parsed in the browser; this is
// RFC 4180 plus what banks actually produce: a byte-order mark, CRLF or LF line ends, quoted
// fields with commas and line breaks, and semicolon- or tab-separated files.

export interface CsvTable {
  headers: string[];
  /** Data rows, each padded or cut to the header length. */
  rows: string[][];
  /** The file line each row starts on (1 = the header), for error messages. */
  lines: number[];
  delimiter: ',' | ';' | '\t';
}

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

/** Picks the delimiter that splits the header line into the most fields, outside quotes. */
function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const best = (Object.keys(counts) as (keyof typeof counts)[]).sort(
    (a, b) => counts[b] - counts[a],
  )[0]!;
  return counts[best] > 0 ? best : ',';
}

/** Splits CSV text into records. Blank lines are skipped. */
export function parseCsv(input: string): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: { fields: string[]; line: number }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;

  const endField = () => {
    fields.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (!(fields.length === 1 && fields[0] === '')) records.push({ fields, line: recordLine });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvError('A quoted field is never closed', recordLine);
  if (field !== '' || fields.length > 0) endRecord();

  const [header, ...data] = records;
  if (!header) throw new CsvError('The file is empty', 1);
  const headers = header.fields.map((h) => h.trim());
  const width = headers.length;
  return {
    headers,
    rows: data.map((r) =>
      r.fields.length >= width
        ? r.fields.slice(0, width)
        : [...r.fields, ...Array<string>(width - r.fields.length).fill('')],
    ),
    lines: data.map((r) => r.line),
    delimiter,
  };
}
