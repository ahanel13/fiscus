// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderRegistry } from '@fiscus/aggregation';
import type { FieldCrypto } from '@fiscus/crypto';
import type { Database } from '@fiscus/db';
import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DEFAULT_JOB_HANDLERS } from './handlers.js';
import { type JobHandler, JobHandlers } from './jobs.js';
import { Runner, type RunnerOptions } from './runner.js';

export interface RunnerModuleConfig {
  db: Database;
  crypto: FieldCrypto;
  providers: ProviderRegistry;
  options?: Partial<RunnerOptions>;
  /** Defaults to `sync` and `remove`. */
  handlers?: JobHandler[];
}

/** Starts the runner with the app, and stops it (releasing leases) before the app shuts down. */
@Injectable()
export class RunnerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(Runner) private readonly runner: Runner) {}

  onApplicationBootstrap(): void {
    this.runner.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.runner.stop();
  }
}

/** The scheduling loop (#81): claims due connections and runs their jobs. */
@Module({})
export class RunnerModule {
  static forRoot(config: RunnerModuleConfig): DynamicModule {
    return {
      module: RunnerModule,
      providers: [
        {
          provide: Runner,
          useFactory: () =>
            new Runner(
              {
                db: config.db,
                crypto: config.crypto,
                providers: config.providers,
                handlers: new JobHandlers(config.handlers ?? DEFAULT_JOB_HANDLERS),
              },
              config.options,
            ),
        },
        RunnerLifecycle,
      ],
      exports: [Runner],
    };
  }
}
