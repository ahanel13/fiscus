// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { CategoriesService } from './categories.service.js';
import { CategoriesController, TransactionsController } from './ledger.controller.js';
import { TransactionsService } from './transactions.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [CategoriesController, TransactionsController],
  providers: [CategoriesService, TransactionsService],
})
export class LedgerModule {}
