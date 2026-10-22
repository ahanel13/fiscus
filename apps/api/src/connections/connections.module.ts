// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { HouseholdsModule } from '../households/households.module.js';
import { ConnectService } from './connect.service.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { PlaidController } from './plaid.controller.js';

@Module({
  imports: [HouseholdsModule, AccountsModule],
  controllers: [ConnectionsController, PlaidController],
  providers: [ConnectionsService, ConnectService],
})
export class ConnectionsModule {}
