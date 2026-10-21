// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  appendActivity,
  type DbHandle,
  instanceSettings,
  userContext,
  withContext,
} from '@fiscus/db';
import {
  INSTANCE_SETTING_KEYS,
  type InstanceSettingKey,
  type InstanceSettings,
  instanceSettingsFrom,
  instanceSettingValue,
  type UpdateInstanceSettings,
} from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../database/database.module.js';

/** How long a read is reused. Another api process sees a change within this long. */
export const SETTINGS_CACHE_MS = 30_000;

/**
 * Instance settings (#400): what the registry in @fiscus/shared defines, with an admin's changes
 * from `instance_settings`. Reads are cached briefly; this process's own writes clear the cache.
 * Writes go through fiscus_set_instance_setting(), which checks the caller is an instance admin
 * (migration 0035), and each change is on the instance activity chain with its old and new value.
 */
@Injectable()
export class InstanceSettingsService {
  #cache: { settings: InstanceSettings; until: number } | null = null;

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  async all(): Promise<InstanceSettings> {
    if (this.#cache && this.#cache.until > Date.now()) return this.#cache.settings;
    const rows = await this.db.db
      .select({ key: instanceSettings.key, value: instanceSettings.value })
      .from(instanceSettings);
    const settings = instanceSettingsFrom(new Map(rows.map((r) => [r.key, r.value])));
    this.#cache = { settings, until: Date.now() + SETTINGS_CACHE_MS };
    return settings;
  }

  async get<K extends InstanceSettingKey>(key: K): Promise<InstanceSettings[K]> {
    return (await this.all())[key];
  }

  /**
   * Applies an admin's changes (already validated by the registry), all or none. A value equal to
   * the current one isn't a change: nothing is written or logged for it.
   */
  async update(
    adminUserId: string,
    changes: UpdateInstanceSettings,
    ip: string | null,
  ): Promise<InstanceSettings> {
    this.#cache = null;
    await withContext(this.db.db, userContext(adminUserId), async (tx) => {
      const stored = new Map(
        (
          await tx
            .select({ key: instanceSettings.key, value: instanceSettings.value })
            .from(instanceSettings)
        ).map((r) => [r.key, r.value]),
      );
      for (const key of INSTANCE_SETTING_KEYS) {
        const to = changes[key];
        if (to === undefined || instanceSettingValue(key, stored.get(key)) === to) continue;
        const [row] = (
          await tx.execute<{ old: unknown }>(
            sql`SELECT fiscus_set_instance_setting(${key}, ${JSON.stringify(to)}::jsonb) AS old`,
          )
        ).rows;
        // What it was when the change took effect (another admin may have changed it since).
        const from = instanceSettingValue(key, row?.old ?? undefined);
        // Settings hold no secrets, so their values are safe in the log (ADR 0005 §4).
        await appendActivity(tx, {
          actorKind: 'instance_admin',
          actorUserId: adminUserId,
          householdId: null,
          action: 'admin.instance_setting_changed',
          targetType: 'instance_setting',
          targetId: key,
          metadata: { key, from, to },
          ip,
        });
      }
    });
    this.#cache = null;
    return this.all();
  }
}
