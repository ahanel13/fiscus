// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { ConsentRequestsController } from './consent-requests.controller.js';
import { ConsentRequestsService } from './consent-requests.service.js';

/** Consent requests (#265, ADR 0012 §Departures item 5). */
@Module({
  imports: [HouseholdsModule],
  controllers: [ConsentRequestsController],
  providers: [ConsentRequestsService],
})
export class ConsentRequestsModule {}
