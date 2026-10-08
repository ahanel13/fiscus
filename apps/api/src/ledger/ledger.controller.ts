// SPDX-License-Identifier: AGPL-3.0-or-later
import { etagFor, parseIfMatch } from '@fiscus/domain';
import {
  type BulkUpdateResult,
  bulkUpdateTransactionsSchema,
  type CashFlow,
  cashFlowQuerySchema,
  type Category,
  type CategoryGroup,
  createCategoryGroupSchema,
  createCategorySchema,
  createTagSchema,
  createTransactionSchema,
  deleteCategoryQuerySchema,
  linkTransferSchema,
  moveTransactionsSchema,
  noteSchema,
  setAttributionSchema,
  setSplitsSchema,
  type Tag,
  type RangeMeta,
  type ReviewCount,
  type Transaction,
  type TransferReview,
  transactionsQuerySchema,
  updateCategoryGroupSchema,
  updateCategorySchema,
  updateTagSchema,
  updateTransactionSchema,
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
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Problem } from '../common/problem.js';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { CashFlowService } from './cash-flow.service.js';
import { CategoriesService } from './categories.service.js';
import { TransactionsService } from './transactions.service.js';

const noteKind = z.enum(['shared', 'mine']);

const requireIfMatch = (header: string | undefined) => {
  const version = parseIfMatch(header);
  if (version === undefined) {
    throw new Problem(
      428,
      'precondition_required',
      'Send If-Match with the version you edited',
      'Use the ETag from GET, e.g. If-Match: "v3".',
    );
  }
  return version;
};

/** Categories and tags (CAT-01–04): everyone reads; owners and members change them. */
@Controller('api/v1/households/:householdId')
@UseGuards(HouseholdGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get('categories')
  async list(@Household() ctx: HouseholdContext): Promise<{ data: CategoryGroup[] }> {
    return { data: await this.categories.list(ctx) };
  }

  @Post('category-groups')
  @HouseholdRoles('owner', 'member')
  async createGroup(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createCategoryGroupSchema)) body: z.infer<typeof createCategoryGroupSchema>,
  ): Promise<{ data: CategoryGroup }> {
    return { data: await this.categories.createGroup(ctx, body) };
  }

  @Patch('category-groups/:groupId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async updateGroup(
    @Household() ctx: HouseholdContext,
    @Param('groupId', UuidPipe) groupId: string,
    @Body(new ZodPipe(updateCategoryGroupSchema)) body: z.infer<typeof updateCategoryGroupSchema>,
  ): Promise<void> {
    await this.categories.updateGroup(ctx, groupId, body);
  }

  @Delete('category-groups/:groupId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async deleteGroup(
    @Household() ctx: HouseholdContext,
    @Param('groupId', UuidPipe) groupId: string,
  ): Promise<void> {
    await this.categories.deleteGroup(ctx, groupId);
  }

  @Post('categories')
  @HouseholdRoles('owner', 'member')
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createCategorySchema)) body: z.infer<typeof createCategorySchema>,
  ): Promise<{ data: Category }> {
    return { data: await this.categories.createCategory(ctx, body) };
  }

  @Patch('categories/:categoryId')
  @HouseholdRoles('owner', 'member')
  async update(
    @Household() ctx: HouseholdContext,
    @Param('categoryId', UuidPipe) categoryId: string,
    @Body(new ZodPipe(updateCategorySchema)) body: z.infer<typeof updateCategorySchema>,
  ): Promise<{ data: Category }> {
    return { data: await this.categories.updateCategory(ctx, categoryId, body) };
  }

  @Delete('categories/:categoryId')
  @HouseholdRoles('owner', 'member')
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('categoryId', UuidPipe) categoryId: string,
    @Query(new ZodPipe(deleteCategoryQuerySchema)) query: z.infer<typeof deleteCategoryQuerySchema>,
  ): Promise<{ data: { moved: number } }> {
    return { data: await this.categories.deleteCategory(ctx, categoryId, query.replaceWith) };
  }

  @Get('tags')
  async listTags(@Household() ctx: HouseholdContext): Promise<{ data: Tag[] }> {
    return { data: await this.categories.listTags(ctx) };
  }

  @Post('tags')
  @HouseholdRoles('owner', 'member')
  async createTag(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createTagSchema)) body: z.infer<typeof createTagSchema>,
  ): Promise<{ data: Tag }> {
    return { data: await this.categories.createTag(ctx, body) };
  }

  @Patch('tags/:tagId')
  @HouseholdRoles('owner', 'member')
  async updateTag(
    @Household() ctx: HouseholdContext,
    @Param('tagId', UuidPipe) tagId: string,
    @Body(new ZodPipe(updateTagSchema)) body: z.infer<typeof updateTagSchema>,
  ): Promise<{ data: Tag }> {
    return { data: await this.categories.updateTag(ctx, tagId, body) };
  }

  @Delete('tags/:tagId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async deleteTag(
    @Household() ctx: HouseholdContext,
    @Param('tagId', UuidPipe) tagId: string,
  ): Promise<void> {
    await this.categories.deleteTag(ctx, tagId);
  }
}

/**
 * Transactions (permissions §4.3–4.5). Invisible transactions answer 404; visible ones you may
 * not change answer 403. Purchases shared with you through attribution never reveal the
 * account they were paid from (F1).
 */
@Controller('api/v1/households/:householdId/transactions')
@UseGuards(HouseholdGuard)
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  async list(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(transactionsQuerySchema)) query: z.infer<typeof transactionsQuerySchema>,
  ): Promise<{
    data: Transaction[];
    meta: { nextCursor: string | null; scope: 'visible_to_you'; range: RangeMeta | null };
  }> {
    const { data, nextCursor, range } = await this.transactions.list(ctx, query);
    return { data, meta: { nextCursor, scope: 'visible_to_you', range } };
  }

  @Post()
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createTransactionSchema)) body: z.infer<typeof createTransactionSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Transaction }> {
    const txn = await this.transactions.create(ctx, body);
    void reply.status(201).header('etag', etagFor(txn.version));
    return { data: txn };
  }

  /** Bulk edit: each row is allowed or refused on its own. */
  @Patch()
  async bulk(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(bulkUpdateTransactionsSchema))
    body: z.infer<typeof bulkUpdateTransactionsSchema>,
  ): Promise<{ data: BulkUpdateResult }> {
    return { data: await this.transactions.bulkUpdate(ctx, body) };
  }

  /** TXN-12: move to another account; each row is allowed or refused on its own. */
  @Post('move')
  @HttpCode(200)
  async move(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(moveTransactionsSchema)) body: z.infer<typeof moveTransactionsSchema>,
  ): Promise<{ data: BulkUpdateResult }> {
    return { data: await this.transactions.move(ctx, body) };
  }

  /** The review queue's size (#44), for the badge on Transactions. */
  @Get('review-count')
  async reviewCount(@Household() ctx: HouseholdContext): Promise<{ data: ReviewCount }> {
    return { data: await this.transactions.reviewCount(ctx) };
  }

  /** Suggested transfer pairs, and transfers with no other side (transfers.md §2). */
  @Get('transfer-review')
  async transferReview(@Household() ctx: HouseholdContext): Promise<{ data: TransferReview }> {
    return { data: await this.transactions.transferReview(ctx) };
  }

  @Post('transfer-review/link-all')
  @HttpCode(200)
  async linkAllTransfers(
    @Household() ctx: HouseholdContext,
  ): Promise<{ data: { linked: number } }> {
    return { data: await this.transactions.linkAllTransfers(ctx) };
  }

  @Get(':transactionId')
  async get(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Transaction }> {
    const txn = await this.transactions.get(ctx, id);
    void reply.header('etag', etagFor(txn.version));
    return { data: txn };
  }

  @Patch(':transactionId')
  async update(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateTransactionSchema)) body: z.infer<typeof updateTransactionSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ data: Transaction }> {
    const txn = await this.transactions.update(ctx, id, requireIfMatch(ifMatch), body);
    void reply.header('etag', etagFor(txn.version));
    return { data: txn };
  }

  @Delete(':transactionId')
  @HttpCode(204)
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
  ): Promise<void> {
    await this.transactions.remove(ctx, id);
  }

  /** Possible other legs to link it to as a transfer, closest date first (TXN-08). */
  @Get(':transactionId/transfer-candidates')
  async transferCandidates(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
  ): Promise<{ data: Transaction[] }> {
    return { data: await this.transactions.transferCandidates(ctx, id) };
  }

  @Post(':transactionId/transfer')
  @HttpCode(200)
  async linkTransfer(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Body(new ZodPipe(linkTransferSchema)) body: z.infer<typeof linkTransferSchema>,
  ): Promise<{ data: Transaction }> {
    return { data: await this.transactions.linkTransfer(ctx, id, body) };
  }

  @Delete(':transactionId/transfer')
  @HttpCode(204)
  async unlinkTransfer(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
  ): Promise<void> {
    await this.transactions.unlinkTransfer(ctx, id);
  }

  @Put(':transactionId/attribution')
  @HttpCode(204)
  async setAttribution(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Body(new ZodPipe(setAttributionSchema)) body: z.infer<typeof setAttributionSchema>,
  ): Promise<void> {
    await this.transactions.setAttribution(ctx, id, body.attribution);
  }

  @Put(':transactionId/splits')
  async setSplits(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Body(new ZodPipe(setSplitsSchema)) body: z.infer<typeof setSplitsSchema>,
  ): Promise<{ data: Transaction[] }> {
    return { data: await this.transactions.setSplits(ctx, id, body) };
  }

  @Delete(':transactionId/splits')
  @HttpCode(204)
  async removeSplits(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
  ): Promise<void> {
    await this.transactions.removeSplits(ctx, id);
  }

  @Put(':transactionId/notes/:kind')
  @HttpCode(204)
  async setNote(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Param('kind', new ZodPipe(noteKind)) kind: 'shared' | 'mine',
    @Body(new ZodPipe(noteSchema)) body: z.infer<typeof noteSchema>,
  ): Promise<void> {
    await this.transactions.setNote(ctx, id, kind, body.body);
  }

  @Delete(':transactionId/notes/:kind')
  @HttpCode(204)
  async deleteNote(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Param('kind', new ZodPipe(noteKind)) kind: 'shared' | 'mine',
  ): Promise<void> {
    await this.transactions.setNote(ctx, id, kind, null);
  }
}

/** Income, spending, and net per period (ADR 0011): the numbers behind cash-flow views. */
@Controller('api/v1/households/:householdId/cash-flow')
@UseGuards(HouseholdGuard)
export class CashFlowController {
  constructor(private readonly cashFlow: CashFlowService) {}

  @Get()
  async get(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(cashFlowQuerySchema)) query: z.infer<typeof cashFlowQuerySchema>,
  ): Promise<{ data: CashFlow; meta: { scope: 'visible_to_you' } }> {
    return { data: await this.cashFlow.get(ctx, query), meta: { scope: 'visible_to_you' } };
  }
}
