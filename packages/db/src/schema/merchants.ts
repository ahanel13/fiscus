// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { bytea, id, timestamps } from '../columns.js';

/**
 * Merchants' logos (#423), as a provider points to them: fetched once by the worker and served
 * from Fiscus's own origin, so browsers never ask the provider's CDN and it never learns who
 * looks. Global reference data, like institutions: no household, no row-level security. A
 * transaction names its logo; nothing here says who bought what.
 */
export const merchantLogos = pgTable(
  'merchant_logos',
  {
    id: id(),
    provider: text().notNull(),
    /** The merchant at the provider (Plaid's `merchant_entity_id`), else the logo's address. */
    providerKey: text().notNull(),
    /** Where the provider keeps it: an https address on its own CDN. */
    sourceUrl: text().notNull(),
    /** The image, once fetched: PNG, JPEG or WebP, at most 64 KB. */
    image: bytea('image'),
    contentType: text(),
    fetchedAt: timestamp({ withTimezone: true }),
    /** Failed fetches, to give up after a few; when the last one was. */
    failures: integer().notNull().default(0),
    failedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('merchant_logos_provider_key').on(t.provider, t.providerKey),
    check(
      'merchant_logos_image',
      sql`${t.image} IS NULL OR (octet_length(${t.image}) <= 65536 AND ${t.contentType} IN ('image/png', 'image/jpeg', 'image/webp'))`,
    ),
  ],
);
