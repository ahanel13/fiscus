import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { HouseholdAccess } from './household-access.js';
import { HouseholdsController } from './households.controller.js';
import { HouseholdsService } from './households.service.js';
import { InvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [AuthModule],
  controllers: [HouseholdsController, InvitesController],
  providers: [HouseholdAccess, HouseholdsService, InvitesService, MembersService],
  exports: [HouseholdAccess, HouseholdsService],
})
export class HouseholdsModule {}
