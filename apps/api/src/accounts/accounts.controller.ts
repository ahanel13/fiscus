// SPDX-License-Identifier: AGPL-3.0-or-later
import { etagFor, parseIfMatch } from '@fiscus/domain';
import {
  type Account,
  accountsQuerySchema,
  type BalancePoint,
  createAccountSchema,
  balancesQuerySchema,
  isoDateSchema,
  type NetWorth,
  netWorthQuerySchema,
  setBalanceSchema,
  setOwnersSchema,
  updateAccountSchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { Problem } from '../common/problem.js';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { AccountsService } from './accounts.service.js';

/**
 * Accounts, ownership, visibility, and balances (permissions §4.2). Accounts a member can't see
 * answer 404; visible accounts they may not change answer 403.
 */
@Controller('api/v1/households/:householdId')
@UseGuards(HouseholdGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  /** ACC-05: every visible account, narrowed by the lens. */
  @Get('accounts')
  async list(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(accountsQuerySchema)) query: z.infer<typeof accountsQuerySchema>,
  ): Promise<{ data: Account[]; meta: { scope: 'visible_to_you' } }> {
    return {
      data: await this.accounts.list(ctx, query.lens, query.include),
      meta: { scope: 'visible_to_you' },
    };
  }

  /** ACC-04: owners and members add manual accounts; viewers can't own accounts. */
  @Post('accounts')
  @HouseholdRoles('owner', 'member')
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createAccountSchema)) body: z.infer<typeof createAccountSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Account }> {
    const account = await this.accounts.create(ctx, body);
    void reply.status(201).header('etag', etagFor(account.version));
    return { data: account };
  }

  @Get('accounts/:accountId')
  async get(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Account }> {
    const account = await this.accounts.get(ctx, accountId);
    void reply.header('etag', etagFor(account.version));
    return { data: account };
  }

  /** ACC-06/07/11: owners edit. Requires If-Match (first save wins, per field). */
  @Patch('accounts/:accountId')
  async update(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateAccountSchema)) body: z.infer<typeof updateAccountSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Account }> {
    const baseVersion = parseIfMatch(ifMatch);
    if (baseVersion === undefined) {
      throw new Problem(
        428,
        'precondition_required',
        'Send If-Match with the version you edited',
        'Use the ETag from GET, e.g. If-Match: "v3".',
      );
    }
    const account = await this.accounts.update(ctx, accountId, baseVersion, body);
    void reply.header('etag', etagFor(account.version));
    return { data: account };
  }

  /** ACC-08: owners replace the owner set. You can remove only yourself. */
  @Put('accounts/:accountId/owners')
  @HttpCode(204)
  async setOwners(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Body(new ZodPipe(setOwnersSchema)) body: z.infer<typeof setOwnersSchema>,
  ): Promise<void> {
    await this.accounts.setOwners(ctx, accountId, body.owners);
  }

  /** ACC-09: close or reopen (history is kept). */
  @Post('accounts/:accountId/close')
  @HttpCode(204)
  async close(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
  ): Promise<void> {
    await this.accounts.setClosed(ctx, accountId, true);
  }

  @Post('accounts/:accountId/reopen')
  @HttpCode(204)
  async reopen(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
  ): Promise<void> {
    await this.accounts.setClosed(ctx, accountId, false);
  }

  @Get('accounts/:accountId/balances')
  async balances(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Query(new ZodPipe(balancesQuerySchema)) window: z.infer<typeof balancesQuerySchema>,
  ): Promise<{ data: BalancePoint[] }> {
    return { data: await this.accounts.balances(ctx, accountId, window) };
  }

  /** Owners set a day's balance (manual accounts, or an anchor for transaction-tracked ones). */
  @Put('accounts/:accountId/balances/:date')
  async setBalance(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Param('date', new ZodPipe(isoDateSchema)) date: string,
    @Body(new ZodPipe(setBalanceSchema)) body: z.infer<typeof setBalanceSchema>,
  ): Promise<{ data: BalancePoint }> {
    return { data: await this.accounts.setBalance(ctx, accountId, date, body) };
  }

  /** Net worth "visible to you" (F3): never includes accounts hidden from the caller. */
  @Get('net-worth')
  async netWorth(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(netWorthQuerySchema)) query: z.infer<typeof netWorthQuerySchema>,
  ): Promise<{ data: NetWorth; meta: { scope: 'visible_to_you' } }> {
    return {
      data: await this.accounts.netWorth(ctx, query.lens, query),
      meta: { scope: 'visible_to_you' },
    };
  }
}
