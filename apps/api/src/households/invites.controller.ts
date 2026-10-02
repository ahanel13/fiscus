import { type InvitePreview, inviteSignupSchema } from '@fiscus/shared';
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth, Public } from '../auth/decorators.js';
import { type SignedIn, SignInService } from '../auth/sign-in.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { InvitesService } from './invites.service.js';

const tokenSchema = z.object({ token: z.string().min(1) });

/** Invite tokens are only ever sent in request bodies, never in URLs (they'd end up in logs). */
@Controller('api/v1/invites')
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly signIns: SignInService,
  ) {}

  @Public()
  @Post('lookup')
  @HttpCode(200)
  async lookup(
    @Body(new ZodPipe(tokenSchema)) body: z.infer<typeof tokenSchema>,
  ): Promise<{ data: InvitePreview }> {
    return { data: await this.invites.preview(body.token) };
  }

  @Post('accept')
  @HttpCode(200)
  async accept(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(tokenSchema)) body: z.infer<typeof tokenSchema>,
  ): Promise<{ data: { householdId: string; memberId: string } }> {
    return { data: await this.invites.accept(body.token, auth.user) };
  }

  @Public()
  @Post('signup')
  async signup(
    @Body(new ZodPipe(tokenSchema.extend(inviteSignupSchema.shape)))
    body: z.infer<typeof tokenSchema> & z.infer<typeof inviteSignupSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignedIn> {
    const user = await this.invites.signup(body.token, body.password, body.displayName);
    return this.signIns.signIn(user, req, reply);
  }
}
