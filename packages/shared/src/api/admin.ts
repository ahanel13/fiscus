// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// The instance admin's console (/api/v1/admin, permissions §5). Admin responses are allow-lists:
// strict schemas, so a field nobody added here can't reach the admin (permissions §7, D16).

// ── Instance settings (#400) ─────────────────────────────────────────────────────────────────

/**
 * Every instance setting, its schema and its default. A setting no admin has changed has no row
 * in `instance_settings`, and reads as its default; so does a stored value that no longer fits
 * its schema. Values here are never secrets: each change is audit-logged with old and new values.
 */
export const INSTANCE_SETTINGS = {
  /** Households may bring their own Plaid keys instead of using the instance's (#83). */
  'plaid.allowHouseholdKeys': { schema: z.boolean(), default: true },
  /** Households may connect banks through SimpleFIN (#91). */
  'simplefin.enabled': { schema: z.boolean(), default: true },
  /** How often scheduled syncs run, in hours (walkthrough §8). */
  'sync.intervalHours': { schema: z.number().int().min(1).max(24), default: 4 },
  /** Members may ask for a sync now, between scheduled ones (D10). */
  'plaid.refreshNowEnabled': { schema: z.boolean(), default: true },
} as const;

export type InstanceSettingKey = keyof typeof INSTANCE_SETTINGS;
export type InstanceSettings = {
  -readonly [K in InstanceSettingKey]: z.infer<(typeof INSTANCE_SETTINGS)[K]['schema']>;
};

export const INSTANCE_SETTING_KEYS = Object.keys(INSTANCE_SETTINGS) as InstanceSettingKey[];

const settingSchemas = Object.fromEntries(
  INSTANCE_SETTING_KEYS.map((k) => [k, INSTANCE_SETTINGS[k].schema]),
) as { [K in InstanceSettingKey]: (typeof INSTANCE_SETTINGS)[K]['schema'] };

/** All settings, as the admin reads them. */
export const instanceSettingsSchema = z.strictObject(settingSchemas);

/** A change to one or more settings; unknown keys are refused. */
export const updateInstanceSettingsSchema = z
  .strictObject(settingSchemas)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one setting' });
export type UpdateInstanceSettings = z.infer<typeof updateInstanceSettingsSchema>;

/** A stored value, or the setting's default when there is none or it no longer fits. */
export function instanceSettingValue<K extends InstanceSettingKey>(
  key: K,
  stored: unknown,
): InstanceSettings[K] {
  const parsed = INSTANCE_SETTINGS[key].schema.safeParse(stored);
  return (parsed.success ? parsed.data : INSTANCE_SETTINGS[key].default) as InstanceSettings[K];
}

/** Every setting, from the stored rows (key → value); missing ones are defaults. */
export function instanceSettingsFrom(stored: ReadonlyMap<string, unknown>): InstanceSettings {
  return Object.fromEntries(
    INSTANCE_SETTING_KEYS.map((k) => [k, instanceSettingValue(k, stored.get(k))]),
  ) as InstanceSettings;
}

// ── Bank connections (#400, walkthrough §8) ──────────────────────────────────────────────────

/** Plaid's environments: sandbox has fake banks only (D17). */
export const plaidEnvironmentSchema = z.enum(['sandbox', 'production']);
export type PlaidEnvironment = z.infer<typeof plaidEnvironmentSchema>;

/**
 * Server → Bank connections: how this server connects to banks. Counts only, never content (D16):
 * no balances, account names, transactions, or household names. Connection counts come with #78.
 */
export const bankConnectionsOverviewSchema = z.strictObject({
  plaid: z.strictObject({
    /** The instance's Plaid keys are set in the server's environment. */
    configured: z.boolean(),
    /** Null when not configured. */
    environment: plaidEnvironmentSchema.nullable(),
  }),
  simplefin: z.strictObject({ enabled: z.boolean() }),
  settings: instanceSettingsSchema,
});
export type BankConnectionsOverview = z.infer<typeof bankConnectionsOverviewSchema>;
