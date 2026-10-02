import { Controller, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { AuthService } from '../auth/auth.service.js';
import { Auth, RequireInstanceAdmin, RequireRecentAuth } from '../auth/decorators.js';

/** Instance-admin user management (permissions §5). The full admin console arrives in #22. */
@Controller('api/v1/admin/users')
@RequireInstanceAdmin()
export class AdminUsersController {
  constructor(private readonly auth: AuthService) {}

  @Post(':userId/password-reset-link')
  @RequireRecentAuth()
  async createResetLink(
    @Auth() auth: AuthContext,
    @Param('userId') userId: string,
    @Req() req: FastifyRequest,
  ): Promise<{ data: { url: string; expiresAt: string } }> {
    return { data: await this.auth.createPasswordResetLink(auth.user.id, userId, req.ip) };
  }
}
