// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { Problem } from './problem.js';

/** Validates and parses a request body with a zod schema from @fiscus/shared. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new Problem(
      422,
      'validation_failed',
      'Some fields are invalid',
      undefined,
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    );
  }
}
