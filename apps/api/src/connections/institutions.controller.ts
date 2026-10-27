// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DbHandle, institutions } from '@fiscus/db';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { UuidPipe } from '../common/uuid-pipe.js';
import { problems } from '../common/problem.js';
import { DB } from '../database/database.module.js';

/**
 * A bank's logo (#423), from Fiscus's own origin: browsers never load it from the provider, so
 * the Content-Security-Policy stays `img-src 'self'` and the provider never learns who looks.
 * Banks are global reference data (no household, no row-level security), and a logo is a public
 * brand mark, so any signed-in person may fetch one by the id an account or connection gave them.
 */
@Controller('api/v1/institutions')
export class InstitutionsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get(':institutionId/logo')
  async logo(
    @Param('institutionId', UuidPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const [row] = await this.db.db
      .select({ logo: institutions.logoPng })
      .from(institutions)
      .where(eq(institutions.id, id));
    if (!row?.logo) throw problems.notFound();
    void reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, max-age=86400');
    return row.logo;
  }
}
