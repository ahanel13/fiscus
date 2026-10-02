import {
  type AuthStatus,
  loginRequestSchema,
  passwordResetRequestSchema,
  reauthRequestSchema,
  setupRequestSchema,
  signupRequestSchema,
} from '@fiscus/shared';
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { AuthContext } from './auth-context.js';
import { AuthService } from './auth.service.js';
import { AuthCookies } from './cookies.js';
import { Auth, Public } from './decorators.js';
import { SessionService } from './session.service.js';
import { SetupService } from './setup.service.js';
import { clientMeta, type SignedIn, SignInService } from './sign-in.service.js';

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly setup: SetupService,
    private readonly sessions: SessionService,
    private readonly signIns: SignInService,
    private readonly cookies: AuthCookies,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get('status')
  async status(): Promise<{ data: AuthStatus }> {
    return {
      data: {
        setupRequired: await this.setup.isSetupRequired(),
        signupMode: this.config.signupMode,
      },
    };
  }

  /** Issues a CSRF token bound to the current session (or to "no session"). */
  @Public()
  @Get('csrf')
  issueCsrf(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): { data: { csrfToken: string } } {
    return { data: { csrfToken: this.signIns.newCsrf(reply, req.auth?.session.id ?? null) } };
  }

  @Public()
  @Post('setup')
  async completeSetup(
    @Body(new ZodPipe(setupRequestSchema)) body: z.infer<typeof setupRequestSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignedIn> {
    const user = await this.setup.complete(body.setupToken, body);
    await this.audit.record({
      actorKind: 'user',
      actorUserId: user.id,
      action: 'instance.setup_completed',
      targetType: 'user',
      targetId: user.id,
      ip: req.ip,
    });
    return this.signIns.signIn(user, req, reply);
  }

  @Public()
  @Post('signup')
  async signup(
    @Body(new ZodPipe(signupRequestSchema)) body: z.infer<typeof signupRequestSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignedIn> {
    return this.signIns.signIn(await this.auth.signup(body), req, reply);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginRequestSchema)) body: z.infer<typeof loginRequestSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignedIn> {
    return this.signIns.signIn(
      await this.auth.login(body.email, body.password, clientMeta(req)),
      req,
      reply,
    );
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Auth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: { csrfToken: string } }> {
    await this.sessions.revoke(auth.session.id);
    this.cookies.clearSession(reply);
    await this.audit.record({
      actorKind: 'user',
      actorUserId: auth.user.id,
      action: 'auth.logout',
      targetType: 'session',
      targetId: auth.session.id,
      ip: req.ip,
    });
    return { data: { csrfToken: this.signIns.newCsrf(reply, null) } };
  }

  @Post('reauth')
  @HttpCode(204)
  async reauth(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(reauthRequestSchema)) body: z.infer<typeof reauthRequestSchema>,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.auth.reauthenticate(auth.user.id, auth.session.id, body.password, req.ip);
  }

  @Public()
  @Post('password-reset')
  @HttpCode(204)
  async resetPassword(
    @Body(new ZodPipe(passwordResetRequestSchema))
    body: z.infer<typeof passwordResetRequestSchema>,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password, req.ip);
  }
}
