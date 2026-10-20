// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment node
// (reads public/.well-known/security.txt from disk)
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;

/** The file's `Field: value` lines, keyed by field name. */
function fields(): Map<string, string[]> {
  const text = readFileSync(new URL('../public/.well-known/security.txt', import.meta.url), 'utf8');
  const out = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) out.set(m[1]!, [...(out.get(m[1]!) ?? []), m[2]!.trim()]);
  }
  return out;
}

describe('security.txt (RFC 9116, #310)', () => {
  it('has a contact and a policy', () => {
    expect(fields().get('Contact')?.[0]).toMatch(/^https:\/\//);
    expect(fields().get('Policy')?.[0]).toMatch(/^https:\/\//);
  });

  // RFC 9116 requires Expires, at most a year ahead. This fails 60 days before it lapses, so it's
  // renewed (set to about a year out) before any server serves an expired file.
  it('expires once, more than 60 days and less than a year from now', () => {
    const expires = fields().get('Expires') ?? [];
    expect(expires).toHaveLength(1);
    const at = Date.parse(expires[0]!);
    expect(at - Date.now()).toBeGreaterThan(60 * DAY);
    expect(at - Date.now()).toBeLessThan(366 * DAY);
  });
});
