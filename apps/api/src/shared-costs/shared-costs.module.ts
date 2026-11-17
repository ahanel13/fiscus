// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { AttributionFlagsController } from './attribution-flags.controller.js';
import { AttributionFlagsService } from './attribution-flags.service.js';
import { FundingTargetsController } from './funding-targets.controller.js';
import { FundingTargetsService } from './funding-targets.service.js';
import { IncomeSplitController } from './income-split.controller.js';
import { IncomeSplitService } from './income-split.service.js';
import { SharedCostsController } from './shared-costs.controller.js';
import { SharedCostsService } from './shared-costs.service.js';
import { SplitPoliciesController } from './split-policies.controller.js';
import { SplitPoliciesService } from './split-policies.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [
    AttributionFlagsController,
    FundingTargetsController,
    IncomeSplitController,
    SharedCostsController,
    SplitPoliciesController,
  ],
  providers: [
    AttributionFlagsService,
    FundingTargetsService,
    IncomeSplitService,
    SharedCostsService,
    SplitPoliciesService,
  ],
})
export class SharedCostsModule {}
