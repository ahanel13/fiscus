// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDb, type DbHandle } from '@fiscus/db';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';

export const DB = Symbol('DB');

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  static forRoot(url: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: DB, useFactory: () => createDb(url) }],
      exports: [DB],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
