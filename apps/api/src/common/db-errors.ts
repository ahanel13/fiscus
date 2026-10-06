// SPDX-License-Identifier: AGPL-3.0-or-later

/** The database constraint an error violated, looking through driver and ORM wrappers. */
export function violatedConstraint(err: unknown): string | undefined {
  for (let e = err as { constraint?: unknown; cause?: unknown } | undefined; e;) {
    if (typeof e.constraint === 'string') return e.constraint;
    e = e.cause as typeof e;
  }
  return undefined;
}
