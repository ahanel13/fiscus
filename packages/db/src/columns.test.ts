// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTableConfig, pgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { householdId, id, money, timestamps, versioning } from './columns.js';

const probe = pgTable('probe', {
  id: id(),
  householdId: householdId(),
  amount: money('amount_minor').notNull(),
  ...timestamps(),
  ...versioning(),
});

describe('column helpers', () => {
  const columns = Object.fromEntries(getTableConfig(probe).columns.map((c) => [c.name, c]));

  it('uses uuid keys generated as UUIDv7', () => {
    expect(columns.id?.getSQLType()).toBe('uuid');
    expect(columns.id?.primary).toBe(true);
    const generated = columns.id?.defaultFn?.() as string;
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('stores money as bigint minor units', () => {
    expect(columns.amount_minor?.getSQLType()).toBe('bigint');
  });

  it('uses timezone-aware timestamps', () => {
    expect(columns.created_at?.getSQLType()).toBe('timestamp with time zone');
    expect(columns.updated_at?.getSQLType()).toBe('timestamp with time zone');
  });

  it('adds version and field_versions for optimistic concurrency', () => {
    expect(columns.version?.getSQLType()).toBe('integer');
    expect(columns.field_versions?.getSQLType()).toBe('jsonb');
    expect(columns.household_id?.notNull).toBe(true);
  });
});
