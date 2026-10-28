// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { SharedCostsController } from './shared-costs.controller.js';
import { SharedCostsService } from './shared-costs.service.js';
import { SplitPoliciesController } from './split-policies.controller.js';
import { SplitPoliciesService } from './split-policies.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [SharedCostsController, SplitPoliciesController],
  providers: [SharedCostsService, SplitPoliciesService],
})
export class SharedCostsModule {}
