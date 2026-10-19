// SPDX-License-Identifier: AGPL-3.0-or-later
import { envKeyProvider, FieldCrypto, MasterKeys } from '@fiscus/crypto';
import { type DbHandle, HouseholdKeyStore } from '@fiscus/db';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { DB } from '../database/database.module.js';

export type CryptoConfig = Pick<
  AppConfig,
  | 'encryptionKey'
  | 'encryptionKeyVersion'
  | 'encryptionKeyPrevious'
  | 'encryptionKeyPreviousVersion'
>;

/** The master keys the config names: the current one, and the previous one mid-rotation. */
export const masterKeysFrom = (config: CryptoConfig) =>
  envKeyProvider({
    APP_ENCRYPTION_KEY: config.encryptionKey,
    APP_ENCRYPTION_KEY_VERSION: config.encryptionKeyVersion,
    APP_ENCRYPTION_KEY_PREVIOUS: config.encryptionKeyPrevious,
    APP_ENCRYPTION_KEY_PREVIOUS_VERSION: config.encryptionKeyPreviousVersion,
  }).masterKeys();

/** Field encryption with per-household data keys (ADR 0005). */
@Global()
@Module({})
export class CryptoModule {
  static forRoot(config: CryptoConfig): DynamicModule {
    return {
      module: CryptoModule,
      providers: [
        { provide: MasterKeys, useFactory: () => masterKeysFrom(config) },
        {
          provide: HouseholdKeyStore,
          inject: [DB, MasterKeys],
          useFactory: (db: DbHandle, master: MasterKeys) => new HouseholdKeyStore(db.db, master),
        },
        {
          provide: FieldCrypto,
          inject: [HouseholdKeyStore, MasterKeys],
          useFactory: (keys: HouseholdKeyStore, master: MasterKeys) =>
            new FieldCrypto(keys, master),
        },
      ],
      exports: [MasterKeys, HouseholdKeyStore, FieldCrypto],
    };
  }
}
