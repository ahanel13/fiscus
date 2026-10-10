// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServerInviteSchema, type ServerInvite } from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth, RequireInstanceAdmin } from '../auth/decorators.js';
import { ServerInvitesService } from '../auth/server-invites.service.js';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';

/** Server invites (permissions ADM-08): someone new makes an account, then their own household. */
@Controller('api/v1/admin/invites')
@RequireInstanceAdmin()
export class AdminInvitesController {
  constructor(private readonly invites: ServerInvitesService) {}

  @Post()
  async create(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(createServerInviteSchema)) body: z.infer<typeof createServerInviteSchema>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: { invite: ServerInvite; url: string } }> {
    return { data: await this.invites.create(auth.user.id, body.email, req.ip) };
  }

  @Get()
  async list(): Promise<{ data: ServerInvite[] }> {
    return { data: await this.invites.list() };
  }

  @Delete(':inviteId')
  @HttpCode(204)
  async revoke(
    @Auth() auth: AuthContext,
    @Param('inviteId', UuidPipe) inviteId: string,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.invites.revoke(auth.user.id, inviteId, req.ip);
  }
}
