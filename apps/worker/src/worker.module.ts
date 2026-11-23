// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DynamicModule, Module } from '@nestjs/common';
import { MoveOutModule } from './move-out/move-out.module.js';
import { NotifyModule, type NotifyModuleConfig } from './notify/notify.module.js';
import { RunnerModule, type RunnerModuleConfig } from './runner/runner.module.js';

export interface WorkerModuleConfig extends RunnerModuleConfig {
  /** Notification delivery; left out, the worker only syncs (as some tests run it). */
  notify?: Omit<NotifyModuleConfig, 'db' | 'crypto'>;
  /** Moving out (#253); false, the worker doesn't carry on with moves. */
  moveOut?: boolean;
}

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerModuleConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        RunnerModule.forRoot(config),
        ...(config.moveOut === false
          ? []
          : [MoveOutModule.forRoot({ db: config.db, crypto: config.crypto })]),
        ...(config.notify
          ? [NotifyModule.forRoot({ db: config.db, crypto: config.crypto, ...config.notify })]
          : []),
      ],
    };
  }
}
