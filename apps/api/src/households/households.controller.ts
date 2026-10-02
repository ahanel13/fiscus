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
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth } from '../auth/decorators.js';
import { Problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { HouseholdAccess } from './household-access.js';
import { HouseholdsService } from './households.service.js';
import { InvitesService } from './invites.service.js';
import { MembersService } from './members.service.js';

@Controller('api/v1/households')
export class HouseholdsController {
  constructor(
    private readonly access: HouseholdAccess,
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
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Household }> {
    const household = await this.households.get(
      await this.access.require(auth.user.id, householdId),
    );
    void reply.header('etag', etagFor(household.version));
    return { data: household };
  }

  /** HH-02: owners update settings. Requires If-Match (first save wins, per field). */
  @Patch(':householdId')
  async update(
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateHouseholdSchema)) body: z.infer<typeof updateHouseholdSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Household }> {
    const access = await this.access.require(auth.user.id, householdId, ['owner']);
    const baseVersion = parseIfMatch(ifMatch);
    if (baseVersion === undefined) {
      throw new Problem(
        428,
        'precondition_required',
        'Send If-Match with the version you edited',
        'Use the ETag from GET, e.g. If-Match: "v3".',
      );
    }
    const household = await this.households.update(access, auth.user.id, baseVersion, body);
    void reply.header('etag', etagFor(household.version));
    return { data: household };
  }

  /** HH-03: every member sees the member list; only owners see emails. */
  @Get(':householdId/members')
  async listMembers(
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
  ): Promise<{ data: HouseholdMember[] }> {
    return { data: await this.members.list(await this.access.require(auth.user.id, householdId)) };
  }

  /** HH-04: owners change roles. The last owner can't be demoted. */
  @Patch(':householdId/members/:memberId')
  @HttpCode(204)
  async changeRole(
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
    @Body(new ZodPipe(changeRoleSchema)) body: z.infer<typeof changeRoleSchema>,
  ): Promise<void> {
    const access = await this.access.require(auth.user.id, householdId, ['owner']);
    await this.members.changeRole(access, auth.user.id, memberId, body.role);
  }

  /** HH-04: owners remove other members. */
  @Delete(':householdId/members/:memberId')
  @HttpCode(204)
  async removeMember(
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    const access = await this.access.require(auth.user.id, householdId, ['owner']);
    await this.members.remove(access, auth.user.id, memberId);
  }

  /** HH-05: anyone can leave, except the last owner. */
  @Post(':householdId/leave')
  @HttpCode(204)
  async leave(@Auth() auth: AuthContext, @Param('householdId') householdId: string): Promise<void> {
    await this.members.leave(await this.access.require(auth.user.id, householdId), auth.user.id);
  }

  /** HH-04: owners invite. Returns a link to share (email delivery arrives in M4). */
  @Post(':householdId/invites')
  async createInvite(
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
    @Body(new ZodPipe(createInviteSchema)) body: z.infer<typeof createInviteSchema>,
  ): Promise<{ data: { invite: InviteSummary; url: string } }> {
    const access = await this.access.require(auth.user.id, householdId, ['owner']);
    return { data: await this.invites.create(access, auth.user.id, body.email, body.role) };
  }

  @Get(':householdId/invites')
  async listInvites(
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
  ): Promise<{ data: InviteSummary[] }> {
    const access = await this.access.require(auth.user.id, householdId, ['owner']);
    return { data: await this.invites.listPending(access) };
  }

  @Delete(':householdId/invites/:inviteId')
  @HttpCode(204)
  async revokeInvite(
    @Auth() auth: AuthContext,
    @Param('householdId') householdId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    const access = await this.access.require(auth.user.id, householdId, ['owner']);
    await this.invites.revoke(access, auth.user.id, inviteId);
  }
}
