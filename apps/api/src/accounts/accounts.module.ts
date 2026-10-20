// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { AccountLayoutService } from './account-layout.service.js';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [AccountsController],
  providers: [AccountsService, AccountLayoutService],
  exports: [AccountsService],
})
export class AccountsModule {}
