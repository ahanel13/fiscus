// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { HouseholdsModule } from '../households/households.module.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';

@Module({
  imports: [HouseholdsModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
})
export class ConnectionsModule {}
