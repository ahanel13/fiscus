// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { SplitPoliciesController } from './split-policies.controller.js';
import { SplitPoliciesService } from './split-policies.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [SplitPoliciesController],
  providers: [SplitPoliciesService],
})
export class SharedCostsModule {}
