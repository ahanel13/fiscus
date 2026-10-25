// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { HouseholdsModule } from '../households/households.module.js';
import { ConnectService } from './connect.service.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { PlaidController } from './plaid.controller.js';
import { PlaidKeysController } from './plaid-keys.controller.js';
import { PlaidKeysService } from './plaid-keys.service.js';
import { SimpleFinController } from './simplefin.controller.js';

@Module({
  imports: [HouseholdsModule, AccountsModule, AuthModule],
  controllers: [ConnectionsController, PlaidController, PlaidKeysController, SimpleFinController],
  providers: [ConnectionsService, ConnectService, PlaidKeysService],
})
export class ConnectionsModule {}
