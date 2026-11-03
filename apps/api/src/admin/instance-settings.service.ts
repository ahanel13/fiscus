// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import {
  appendActivity,
  type DbHandle,
  encryptMailPassword,
  instanceSettings,
  MAIL_SETTING_KEY,
  readStoredMail,
  readStoredMailValue,
  userContext,
  withContext,
} from '@fiscus/db';
import { type MailConfig, summarizeMail } from '@fiscus/notify';
import {
  type BankConnectionStats,
  type MailStatus,
  type SetMailSettings,
  INSTANCE_SETTING_KEYS,
  type InstanceSettingKey,
  type InstanceSettings,
  instanceSettingsFrom,
  instanceSettingValue,
  type UpdateInstanceSettings,
} from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
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
  #mailCache: { mail: EffectiveMail; until: number } | null = null;

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    private readonly crypto: FieldCrypto,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

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

  /**
   * The mail server in use (D16): SMTP_URL and MAIL_FROM when they're set, which win; otherwise
   * what an admin saved on the Server page; otherwise none. Cached as settings are.
   */
  async effectiveMail(): Promise<EffectiveMail> {
    if (this.#mailCache && this.#mailCache.until > Date.now()) return this.#mailCache.mail;
    let mail: EffectiveMail;
    if (this.config.mail) {
      mail = { source: 'environment', config: this.config.mail, passwordUnreadable: false };
    } else {
      const stored = await readStoredMail(this.db.db, this.crypto);
      mail = stored
        ? {
            source: 'settings',
            config: {
              from: stored.from,
              server: {
                host: stored.host,
                port: stored.port,
                security: stored.security,
                username: stored.username,
                password: stored.password,
              },
            },
            passwordUnreadable: stored.passwordUnreadable,
          }
        : { source: null, config: null, passwordUnreadable: false };
    }
    this.#mailCache = { mail, until: Date.now() + SETTINGS_CACHE_MS };
    return mail;
  }

  /** Server → Email: the mail server in use, never its password. */
  async mailStatus(): Promise<MailStatus> {
    const mail = await this.effectiveMail();
    if (!mail.config) {
      return {
        configured: false,
        source: null,
        host: null,
        port: null,
        security: null,
        username: null,
        hasPassword: false,
        passwordUnreadable: false,
        from: null,
      };
    }
    const summary = summarizeMail(mail.config);
    return {
      configured: true,
      source: mail.source,
      ...summary,
      hasPassword: summary.hasPassword || mail.passwordUnreadable,
      passwordUnreadable: mail.passwordUnreadable,
    };
  }

  /**
   * Saves the mail server (Server page). The password is encrypted with the instance key; left
   * out, the saved one stays; empty, it's cleared. The activity says what changed, never the
   * password.
   */
  async setMail(adminUserId: string, input: SetMailSettings, ip: string | null): Promise<void> {
    await withContext(this.db.db, userContext(adminUserId), async (tx) => {
      const before = await readStoredMailValue(tx);
      const passwordEnc =
        input.password === undefined
          ? (before?.passwordEnc ?? null)
          : input.password === ''
            ? null
            : encryptMailPassword(this.crypto, input.password);
      const value = {
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username ? input.username : null,
        passwordEnc,
        from: input.from,
      };
      await tx.execute(
        sql`SELECT fiscus_set_instance_setting(${MAIL_SETTING_KEY}, ${JSON.stringify(value)}::jsonb)`,
      );
      const changed = (['host', 'port', 'security', 'username', 'from'] as const).filter(
        (k) => before?.[k] !== value[k],
      );
      await appendActivity(tx, {
        actorKind: 'instance_admin',
        actorUserId: adminUserId,
        householdId: null,
        action: before ? 'admin.mail_settings_changed' : 'admin.mail_settings_set',
        targetType: 'instance_setting',
        targetId: MAIL_SETTING_KEY,
        // Which fields changed, and whether the password did: never their values.
        metadata: { changed, passwordChanged: input.password !== undefined },
        ip,
      });
    });
    this.#mailCache = null;
  }

  /** Forgets the saved mail server. False when there was none. */
  async removeMail(adminUserId: string, ip: string | null): Promise<boolean> {
    const removed = await withContext(this.db.db, userContext(adminUserId), async (tx) => {
      if (!(await readStoredMailValue(tx))) return false;
      // Instance settings can't be deleted by the api's role: an empty value reads as none.
      await tx.execute(sql`SELECT fiscus_set_instance_setting(${MAIL_SETTING_KEY}, '{}'::jsonb)`);
      await appendActivity(tx, {
        actorKind: 'instance_admin',
        actorUserId: adminUserId,
        householdId: null,
        action: 'admin.mail_settings_removed',
        targetType: 'instance_setting',
        targetId: MAIL_SETTING_KEY,
        metadata: {},
        ip,
      });
      return true;
    });
    this.#mailCache = null;
    return removed;
  }

  /**
   * Connections across the instance, as counts (Server → Bank connections, D16), through
   * fiscus_admin_bank_stats(), which checks the caller is an instance admin (migration 0051).
   */
  async bankStats(adminUserId: string): Promise<BankConnectionStats> {
    return withContext(this.db.db, userContext(adminUserId), async (tx) => {
      const [row] = (
        await tx.execute<{ stats: BankConnectionStats }>(
          sql`SELECT fiscus_admin_bank_stats() AS stats`,
        )
      ).rows;
      const stats = row!.stats;
      const last = stats.last24h.lastSyncedAt;
      return {
        ...stats,
        last24h: { ...stats.last24h, lastSyncedAt: last && new Date(last).toISOString() },
      };
    });
  }
}

/** The mail server in use, and where it's set. */
export interface EffectiveMail {
  source: 'environment' | 'settings' | null;
  config: MailConfig | null;
  passwordUnreadable: boolean;
}
