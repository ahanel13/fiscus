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
import { MemberMoves, type MemberMoveOptions } from './member-moves.js';

export interface MoveOutModuleConfig {
  db: Database;
  crypto: FieldCrypto;
  options?: Partial<MemberMoveOptions>;
}

/** Starts carrying on with moves with the app, and stops before it shuts down. */
@Injectable()
export class MemberMovesLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(MemberMoves) private readonly moves: MemberMoves) {}

  onApplicationBootstrap(): void {
    this.moves.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.moves.stop();
  }
}

/** Moving out (#253): the worker's side, under fiscus_maintenance. */
@Module({})
export class MoveOutModule {
  static forRoot(config: MoveOutModuleConfig): DynamicModule {
    return {
      module: MoveOutModule,
      providers: [
        {
          provide: MemberMoves,
          useFactory: () => new MemberMoves(config.db, config.crypto, config.options),
        },
        MemberMovesLifecycle,
      ],
      exports: [MemberMoves],
    };
  }
}
