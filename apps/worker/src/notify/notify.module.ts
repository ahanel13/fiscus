// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { Notifier, type NotifierChannels, type NotifierOptions } from './notifier.js';
import { NotificationRules, type RulesOptions } from './rules/runner.js';

export interface NotifyModuleConfig {
  db: Database;
  crypto: FieldCrypto;
  channels: NotifierChannels;
  options?: Partial<NotifierOptions>;
  /** The rules (#127); left out, only what's written by others is delivered. */
  rules?: Partial<RulesOptions>;
}

/** Starts delivering with the app, and stops before it shuts down. */
@Injectable()
export class NotifierLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(Notifier) private readonly notifier: Notifier) {}

  onApplicationBootstrap(): void {
    this.notifier.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.notifier.stop();
  }
}

/** Notification delivery (#125, #126, #130): routes the outbox and sends what's due. */
@Module({})
export class NotifyModule {
  static forRoot(config: NotifyModuleConfig): DynamicModule {
    return {
      module: NotifyModule,
      providers: [
        {
          provide: Notifier,
          useFactory: () =>
            new Notifier(
              {
                db: config.db,
                crypto: config.crypto,
                channels: config.channels,
                ...(config.rules ? { rules: new NotificationRules(config.db, config.rules) } : {}),
              },
              config.options,
            ),
        },
        NotifierLifecycle,
      ],
      exports: [Notifier],
    };
  }
}
