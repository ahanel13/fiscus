// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import type { EnvVarSpec } from './env.js';

export const nodeEnv = {
  schema: z.enum(['development', 'test', 'production']).default('production'),
  description: 'Runtime mode.',
  example: 'development',
} satisfies EnvVarSpec;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const logLevel = {
  schema: z.enum(LOG_LEVELS).default('info'),
  description: `Minimum log level: ${LOG_LEVELS.join(', ')}.`,
  example: 'info',
} satisfies EnvVarSpec;

export const port = (defaultPort: number) =>
  ({
    schema: z.coerce.number().int().min(1).max(65535).default(defaultPort),
    description: 'Port to listen on.',
    example: String(defaultPort),
  }) satisfies EnvVarSpec;

export const host = {
  schema: z.string().min(1).default('0.0.0.0'),
  description: 'Interface to bind.',
  example: '0.0.0.0',
} satisfies EnvVarSpec;

type NestLogLevel = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

/** Maps our log level to the set of levels Nest's built-in logger should emit. */
export function toNestLogLevels(level: LogLevel): NestLogLevel[] {
  const order: NestLogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];
  return order.slice(0, LOG_LEVELS.indexOf(level) + 1);
}

/** A boolean flag written as `true` / `false`. */
export const booleanFlag = (defaultValue: boolean, description: string) =>
  ({
    schema: z
      .enum(['true', 'false'])
      .default(defaultValue ? 'true' : 'false')
      .transform((v) => v === 'true'),
    description,
    example: String(defaultValue),
  }) satisfies EnvVarSpec;
