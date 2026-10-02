import { etagFor, parseIfMatch } from '@fiscus/domain';
import {
  changeRoleSchema,
  createHouseholdSchema,
  createInviteSchema,
  type Household,
  type HouseholdMember,
  type InviteSummary,
  updateHouseholdSchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth } from '../auth/decorators.js';
import { Problem } from '../common/problem.js';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household as HouseholdCtx,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from './household-context.js';
import { HouseholdsService } from './households.service.js';
import { InvitesService } from './invites.service.js';
import { MembersService } from './members.service.js';

/**
 * Every route with `:householdId` passes HouseholdGuard first: non-members get 404 and members
 * without the role 403, before any validation (permissions §1).
 */
@Controller('api/v1/households')
@UseGuards(HouseholdGuard)
export class HouseholdsController {
  constructor(
    private readonly households: HouseholdsService,
    private readonly members: MembersService,
    private readonly invites: InvitesService,
  ) {}

  @Post()
  async create(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(createHouseholdSchema)) body: z.infer<typeof createHouseholdSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Household }> {
    const household = await this.households.create(auth.user, body);
    void reply.header('etag', etagFor(household.version));
    return { data: household };
  }

  /** HH-01: every member can read household settings. */
  @Get(':householdId')
  async get(
    @HouseholdCtx() ctx: HouseholdContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Household }> {
    const household = await this.households.get(ctx);
    void reply.header('etag', etagFor(household.version));
    return { data: household };
  }

  /** HH-02: owners update settings. Requires If-Match (first save wins, per field). */
  @Patch(':householdId')
  @HouseholdRoles('owner')
  async update(
    @HouseholdCtx() ctx: HouseholdContext,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateHouseholdSchema)) body: z.infer<typeof updateHouseholdSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Household }> {
    const baseVersion = parseIfMatch(ifMatch);
    if (baseVersion === undefined) {
      throw new Problem(
        428,
        'precondition_required',
        'Send If-Match with the version you edited',
        'Use the ETag from GET, e.g. If-Match: "v3".',
      );
    }
    const household = await this.households.update(ctx, baseVersion, body);
    void reply.header('etag', etagFor(household.version));
    return { data: household };
  }

  /** HH-03: every member sees the member list; only owners see emails. */
  @Get(':householdId/members')
  async listMembers(@HouseholdCtx() ctx: HouseholdContext): Promise<{ data: HouseholdMember[] }> {
    return { data: await this.members.list(ctx) };
  }

  /** HH-04: owners change roles. The last owner can't be demoted. */
  @Patch(':householdId/members/:memberId')
  @HouseholdRoles('owner')
  @HttpCode(204)
  async changeRole(
    @HouseholdCtx() ctx: HouseholdContext,
    @Param('memberId', UuidPipe) memberId: string,
    @Body(new ZodPipe(changeRoleSchema)) body: z.infer<typeof changeRoleSchema>,
  ): Promise<void> {
    await this.members.changeRole(ctx, memberId, body.role);
  }

  /** HH-04: owners remove other members. */
  @Delete(':householdId/members/:memberId')
  @HouseholdRoles('owner')
  @HttpCode(204)
  async removeMember(
    @HouseholdCtx() ctx: HouseholdContext,
    @Param('memberId', UuidPipe) memberId: string,
  ): Promise<void> {
    await this.members.remove(ctx, memberId);
  }

  /** HH-05: anyone can leave, except the last owner. */
  @Post(':householdId/leave')
  @HttpCode(204)
  async leave(@HouseholdCtx() ctx: HouseholdContext): Promise<void> {
    await this.members.leave(ctx);
  }

  /** HH-04: owners invite. Returns a link to share (email delivery arrives in M4). */
  @Post(':householdId/invites')
  @HouseholdRoles('owner')
  async createInvite(
    @HouseholdCtx() ctx: HouseholdContext,
    @Body(new ZodPipe(createInviteSchema)) body: z.infer<typeof createInviteSchema>,
  ): Promise<{ data: { invite: InviteSummary; url: string } }> {
    return { data: await this.invites.create(ctx, body.email, body.role) };
  }

  @Get(':householdId/invites')
  @HouseholdRoles('owner')
  async listInvites(@HouseholdCtx() ctx: HouseholdContext): Promise<{ data: InviteSummary[] }> {
    return { data: await this.invites.listPending(ctx) };
  }

  @Delete(':householdId/invites/:inviteId')
  @HouseholdRoles('owner')
  @HttpCode(204)
  async revokeInvite(
    @HouseholdCtx() ctx: HouseholdContext,
    @Param('inviteId', UuidPipe) inviteId: string,
  ): Promise<void> {
    await this.invites.revoke(ctx, inviteId);
  }
}
