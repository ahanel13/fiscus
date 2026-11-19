// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { AllowancesController } from './allowances.controller.js';
import { AllowancesService } from './allowances.service.js';
import { BudgetsController } from './budgets.controller.js';
import { BudgetsService } from './budgets.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [BudgetsController, AllowancesController],
  providers: [BudgetsService, AllowancesService],
})
export class BudgetsModule {}
