/**
 * Field-level optimistic concurrency (API conventions §8): the first save wins, and a later save
 * conflicts only if it changes a field that someone else changed after the version it was based on.
 */

export interface VersionState {
  version: number;
  /** Field name → the version in which it last changed. */
  fieldVersions: Record<string, number>;
}

export interface FieldConflict {
  field: string;
  yourValue: unknown;
  currentValue: unknown;
  changedInVersion: number;
}

export type PatchPlan<T> =
  { ok: true; changes: Partial<T>; next: VersionState } | { ok: false; conflicts: FieldConflict[] };

export function planVersionedPatch<T extends Record<string, unknown>>(
  current: T,
  state: VersionState,
  baseVersion: number,
  patch: Partial<T>,
): PatchPlan<T> {
  const conflicts: FieldConflict[] = [];
  const changes: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined || Object.is(current[field], value)) continue;
    const changedIn = state.fieldVersions[field] ?? 0;
    if (changedIn > baseVersion) {
      conflicts.push({
        field,
        yourValue: value,
        currentValue: current[field],
        changedInVersion: changedIn,
      });
    } else {
      changes[field] = value;
    }
  }

  if (conflicts.length > 0) return { ok: false, conflicts };
  if (Object.keys(changes).length === 0) return { ok: true, changes: {}, next: state };

  const version = state.version + 1;
  const fieldVersions = { ...state.fieldVersions };
  for (const field of Object.keys(changes)) fieldVersions[field] = version;
  return { ok: true, changes: changes as Partial<T>, next: { version, fieldVersions } };
}

/** Parses an `If-Match: "v12"` header. Returns undefined when absent or malformed. */
export function parseIfMatch(header: string | undefined): number | undefined {
  const match = header?.trim().match(/^(?:W\/)?"v(\d+)"$/);
  return match ? Number(match[1]) : undefined;
}

export const etagFor = (version: number) => `"v${version}"`;
