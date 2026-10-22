// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { CashFlowService } from './cash-flow.service.js';
import { CategoriesService } from './categories.service.js';
import { TransactionHistoryService } from './history.service.js';
import {
  CashFlowController,
  CategoriesController,
  TransactionsController,
} from './ledger.controller.js';
import { PreferencesController } from './preferences.controller.js';
import { TransactionsService } from './transactions.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [
    CategoriesController,
    TransactionsController,
    CashFlowController,
    PreferencesController,
  ],
  providers: [CategoriesService, TransactionsService, TransactionHistoryService, CashFlowService],
})
export class LedgerModule {}
