// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { RulesController } from './rules.controller.js';
import { RulesService } from './rules.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [RulesController],
  providers: [RulesService],
})
export class RulesModule {}
