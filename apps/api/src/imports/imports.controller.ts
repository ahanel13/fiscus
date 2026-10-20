// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createImportProfileSchema,
  type ImportBatch,
  type ImportPreview,
  type ImportProfile,
  type ImportFormat,
  importFormatSchema,
  importRequestSchema,
  importRowsSchema,
  type ImportRowsResult,
  type ImportRun,
  startImportSchema,
  updateImportProfileSchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { ImportsService } from './imports.service.js';

type PreviewBody = z.output<typeof importRequestSchema>;
type StartBody = z.output<typeof startImportSchema>;
type RowsBody = z.output<typeof importRowsSchema>;

/**
 * File imports (docs/design/imports.md): preview the whole file, start a run, add rows a part at
 * a time, list, and undo (TXN-09/10). Preview and rows bodies may be up to 25 MB
 * (configure-app.ts); everywhere else keeps Fastify's 1 MB.
 */
@Controller('api/v1/households/:householdId')
@UseGuards(HouseholdGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('imports')
  async list(@Household() ctx: HouseholdContext): Promise<{ data: ImportBatch[] }> {
    return { data: await this.imports.list(ctx) };
  }

  /** How earlier imports mapped category names (lower-cased name → category id). */
  @Get('imports/category-map')
  async categoryMap(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(z.object({ format: importFormatSchema.optional() })))
    query: { format?: ImportFormat },
  ): Promise<{ data: Record<string, string> }> {
    return { data: await this.imports.categoryMap(ctx, query.format) };
  }

  /** Everything importing the file would do, with nothing saved. */
  @Post('imports/preview')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async preview(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(importRequestSchema)) body: PreviewBody,
  ): Promise<{ data: ImportPreview }> {
    return { data: await this.imports.preview(ctx, body) };
  }

  /** Starts a run: new accounts, categories, and tags, and a batch per account. */
  @Post('imports')
  @HouseholdRoles('owner', 'member')
  async start(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(startImportSchema)) body: StartBody,
  ): Promise<{ data: ImportRun }> {
    return { data: await this.imports.start(ctx, body) };
  }

  /** One part of one account's rows. */
  @Post('imports/:batchId/rows')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async addRows(
    @Household() ctx: HouseholdContext,
    @Param('batchId', UuidPipe) batchId: string,
    @Body(new ZodPipe(importRowsSchema)) body: RowsBody,
  ): Promise<{ data: ImportRowsResult }> {
    return { data: await this.imports.addRows(ctx, batchId, body) };
  }

  @Post('imports/:batchId/revert')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async revert(
    @Household() ctx: HouseholdContext,
    @Param('batchId', UuidPipe) batchId: string,
  ): Promise<void> {
    await this.imports.revert(ctx, batchId);
  }

  /** Undoes every account of one file. */
  @Post('import-runs/:runId/revert')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async revertRun(
    @Household() ctx: HouseholdContext,
    @Param('runId', UuidPipe) runId: string,
  ): Promise<void> {
    await this.imports.revertRun(ctx, runId);
  }

  @Get('import-profiles')
  async listProfiles(@Household() ctx: HouseholdContext): Promise<{ data: ImportProfile[] }> {
    return { data: await this.imports.listProfiles(ctx) };
  }

  @Post('import-profiles')
  @HouseholdRoles('owner', 'member')
  async createProfile(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createImportProfileSchema)) body: z.infer<typeof createImportProfileSchema>,
  ): Promise<{ data: ImportProfile }> {
    return { data: await this.imports.createProfile(ctx, body) };
  }

  @Patch('import-profiles/:profileId')
  @HouseholdRoles('owner', 'member')
  async updateProfile(
    @Household() ctx: HouseholdContext,
    @Param('profileId', UuidPipe) id: string,
    @Body(new ZodPipe(updateImportProfileSchema)) body: z.infer<typeof updateImportProfileSchema>,
  ): Promise<{ data: ImportProfile }> {
    return { data: await this.imports.updateProfile(ctx, id, body) };
  }

  @Delete('import-profiles/:profileId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async deleteProfile(
    @Household() ctx: HouseholdContext,
    @Param('profileId', UuidPipe) id: string,
  ): Promise<void> {
    await this.imports.deleteProfile(ctx, id);
  }
}
