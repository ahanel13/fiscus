// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PipeTransform } from '@nestjs/common';
import { problems } from './problem.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed ids are reported as not found, same as ids that don't exist or aren't visible. */
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID.test(value)) throw problems.notFound();
    return value;
  }
}
