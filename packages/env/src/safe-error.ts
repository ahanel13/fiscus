// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fields of a database error that name the schema, never the data: the SQLSTATE code, and which
 * table, column, or constraint. node-postgres also has `detail` ("Key (name)=(Venmo Sam) already
 * exists"), `where`, and `hint`, which can hold values, so they're left out.
 */
const SAFE_FIELDS = [
  'code',
  'severity',
  'schema',
  'table',
  'column',
  'constraint',
  'dataType',
  'routine',
] as const;

const MAX_CAUSES = 5;

/**
 * An error, described for a log without the data it may carry (ADR 0014 §2.3, #308): its class,
 * the schema-only fields of a database error, and its stack frames, then the same for each
 * `cause`. Never the message: a failed query's message holds its SQL and parameters (amounts,
 * names, notes), and a parse error's holds its input. The frames and the code say where and what.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth <= MAX_CAUSES; depth++) {
    parts.push((depth ? 'caused by ' : '') + describeOne(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join('\n');
}

function describeOne(error: unknown): string {
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const fields = SAFE_FIELDS.flatMap((k) => {
    const v = (error as unknown as Record<string, unknown>)[k];
    return typeof v === 'string' || typeof v === 'number' ? [`${k}=${v}`] : [];
  });
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
  return [`${error.name}${fields.length ? ` (${fields.join(', ')})` : ''}`, frames]
    .filter(Boolean)
    .join('\n');
}

/**
 * Logs an uncaught error or unhandled rejection with `describeError`, then exits, as Node would.
 * Node's own report prints the whole error to stderr, message and all.
 */
export function exitOnUnhandled(log: (message: string) => void): void {
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      log(`${event}: ${describeError(error)}`);
      process.exit(1);
    });
  }
}
