// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { HouseholdsModule } from '../households/households.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [HouseholdsModule, AccountsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
