// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  INSTANCE_SETTINGS,
  instanceSettingsFrom,
  instanceSettingsSchema,
  updateInstanceSettingsSchema,
} from './admin.js';

describe('instance settings registry', () => {
  it('has the M2 settings, each with a default its own schema accepts', () => {
    expect(instanceSettingsFrom(new Map())).toEqual({
      'plaid.allowHouseholdKeys': true,
      'simplefin.enabled': true,
      'sync.intervalHours': 4,
      'plaid.refreshNowEnabled': true,
    });
    for (const s of Object.values(INSTANCE_SETTINGS)) {
      expect(s.schema.safeParse(s.default).success).toBe(true);
    }
  });

  it('reads stored values, and the default for one that no longer fits', () => {
    const settings = instanceSettingsFrom(
      new Map<string, unknown>([
        ['sync.intervalHours', 12],
        ['simplefin.enabled', 'yes'],
        ['retired.setting', true],
      ]),
    );
    expect(settings['sync.intervalHours']).toBe(12);
    expect(settings['simplefin.enabled']).toBe(true);
    expect(instanceSettingsSchema.safeParse(settings).success).toBe(true);
  });

  it('validates changes: known keys, in range, at least one', () => {
    const ok = (v: unknown) => updateInstanceSettingsSchema.safeParse(v).success;
    expect(ok({ 'sync.intervalHours': 1 })).toBe(true);
    expect(ok({ 'sync.intervalHours': 24, 'simplefin.enabled': false })).toBe(true);
    expect(ok({ 'sync.intervalHours': 0 })).toBe(false);
    expect(ok({ 'sync.intervalHours': 25 })).toBe(false);
    expect(ok({ 'sync.intervalHours': 1.5 })).toBe(false);
    expect(ok({ 'simplefin.enabled': 'false' })).toBe(false);
    expect(ok({ 'plaid.secret': 'x' })).toBe(false);
    expect(ok({})).toBe(false);
  });
});
