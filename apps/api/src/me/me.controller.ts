// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Me, SessionSummary } from '@fiscus/shared';
import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth } from '../auth/decorators.js';
import { SessionService } from '../auth/session.service.js';
import { problems } from '../common/problem.js';
import { HouseholdAccess } from '../households/household-access.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1/me')
export class MeController {
  constructor(
    private readonly sessions: SessionService,
    private readonly households: HouseholdAccess,
  ) {}

  @Get()
  async me(@Auth() auth: AuthContext): Promise<{ data: Me }> {
    return { data: { ...auth.user, memberships: await this.households.memberships(auth.user.id) } };
  }

  @Get('sessions')
  async listSessions(@Auth() auth: AuthContext): Promise<{ data: SessionSummary[] }> {
    return { data: await this.sessions.list(auth.user.id, auth.session.id) };
  }

  /** Revokes one of your own sessions; anyone else's is reported as not found (TOK-04). */
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@Auth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    if (!UUID.test(id) || !(await this.sessions.revokeOwned(auth.user.id, id))) {
      throw problems.notFound();
    }
  }
}
