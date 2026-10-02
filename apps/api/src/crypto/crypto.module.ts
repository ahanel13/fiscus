import { FieldCrypto, MasterKey } from '@fiscus/crypto';
import { type DbHandle, HouseholdKeyStore } from '@fiscus/db';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { DB } from '../database/database.module.js';

export type CryptoConfig = Pick<AppConfig, 'encryptionKey' | 'encryptionKeyVersion'>;

/** Field encryption with per-household data keys (ADR 0005). */
@Global()
@Module({})
export class CryptoModule {
  static forRoot(config: CryptoConfig): DynamicModule {
    return {
      module: CryptoModule,
      providers: [
        {
          provide: MasterKey,
          useFactory: () => MasterKey.fromBase64(config.encryptionKey, config.encryptionKeyVersion),
        },
        {
          provide: HouseholdKeyStore,
          inject: [DB, MasterKey],
          useFactory: (db: DbHandle, master: MasterKey) => new HouseholdKeyStore(db.db, master),
        },
        {
          provide: FieldCrypto,
          inject: [HouseholdKeyStore, MasterKey],
          useFactory: (keys: HouseholdKeyStore, master: MasterKey) => new FieldCrypto(keys, master),
        },
      ],
      exports: [MasterKey, HouseholdKeyStore, FieldCrypto],
    };
  }
}
