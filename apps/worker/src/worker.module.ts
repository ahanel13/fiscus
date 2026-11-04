// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DynamicModule, Module } from '@nestjs/common';
import { NotifyModule, type NotifyModuleConfig } from './notify/notify.module.js';
import { RunnerModule, type RunnerModuleConfig } from './runner/runner.module.js';

export interface WorkerModuleConfig extends RunnerModuleConfig {
  /** Notification delivery; left out, the worker only syncs (as some tests run it). */
  notify?: Omit<NotifyModuleConfig, 'db' | 'crypto'>;
}

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerModuleConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        RunnerModule.forRoot(config),
        ...(config.notify
          ? [NotifyModule.forRoot({ db: config.db, crypto: config.crypto, ...config.notify })]
          : []),
      ],
    };
  }
}
