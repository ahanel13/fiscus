// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { AttributionFlagsController } from './attribution-flags.controller.js';
import { AttributionFlagsService } from './attribution-flags.service.js';
import { SharedCostsController } from './shared-costs.controller.js';
import { SharedCostsService } from './shared-costs.service.js';
import { SplitPoliciesController } from './split-policies.controller.js';
import { SplitPoliciesService } from './split-policies.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [AttributionFlagsController, SharedCostsController, SplitPoliciesController],
  providers: [AttributionFlagsService, SharedCostsService, SplitPoliciesService],
})
export class SharedCostsModule {}
