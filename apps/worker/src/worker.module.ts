// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DynamicModule, Module } from '@nestjs/common';
import { RunnerModule, type RunnerModuleConfig } from './runner/runner.module.js';

@Module({})
export class WorkerModule {
  static forRoot(config: RunnerModuleConfig): DynamicModule {
    return { module: WorkerModule, imports: [RunnerModule.forRoot(config)] };
  }
}
