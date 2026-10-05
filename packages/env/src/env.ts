// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface EnvVarSpec<T extends z.ZodType = z.ZodType> {
  schema: T;
  description: string;
  /** Value written to .env.example. Defaults to empty. */
  example?: string;
  /** Secrets are redacted from logs and documented as `NAME_FILE`-friendly. */
  secret?: boolean;
}

export interface EnvDefinition<V extends Record<string, EnvVarSpec>> {
  service: string;
  vars: V;
  schema: z.ZodObject<{ [K in keyof V]: V[K]['schema'] }>;
}

export type EnvValues<D> =
  D extends EnvDefinition<infer V> ? z.infer<EnvDefinition<V>['schema']> : never;

export function defineEnv<const V extends Record<string, EnvVarSpec>>(
  service: string,
  vars: V,
): EnvDefinition<V> {
  const shape = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.schema])) as {
    [K in keyof V]: V[K]['schema'];
  };
  return { service, vars, schema: z.object(shape) };
}

export class EnvError extends Error {
  constructor(
    readonly service: string,
    readonly problems: readonly string[],
  ) {
    super(
      `Invalid ${service} configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Every variable can also be set as NAME_FILE pointing to a file that contains the value.',
    );
    this.name = 'EnvError';
  }
}

export interface LoadEnvOptions {
  source?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

/**
 * Parses and validates environment variables. `NAME_FILE` (Docker/Proxmox secrets) is accepted
 * for every variable. All problems are reported at once, and values never appear in errors.
 */
export function loadEnv<V extends Record<string, EnvVarSpec>>(
  def: EnvDefinition<V>,
  { source = process.env, readFile = (path) => readFileSync(path, 'utf8') }: LoadEnvOptions = {},
): EnvValues<EnvDefinition<V>> {
  const problems: string[] = [];
  const raw: Record<string, string | undefined> = {};

  for (const name of Object.keys(def.vars)) {
    const direct = source[name];
    const filePath = source[`${name}_FILE`];
    if (direct !== undefined && filePath !== undefined) {
      problems.push(`${name}: set either ${name} or ${name}_FILE, not both`);
      continue;
    }
    if (filePath !== undefined) {
      try {
        raw[name] = readFile(filePath).replace(/\r?\n$/, '');
      } catch {
        problems.push(`${name}_FILE: cannot read ${filePath}`);
      }
      continue;
    }
    raw[name] = direct === '' ? undefined : direct;
  }

  const result = def.schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? '(root)');
      const message = raw[name] === undefined ? 'is required' : issue.message;
      problems.push(`${name}: ${message}`);
    }
  }

  if (problems.length > 0 || !result.success) {
    throw new EnvError(def.service, problems);
  }
  return result.data as EnvValues<EnvDefinition<V>>;
}

/** Like `loadEnv`, but prints the problems and exits, for use at the top of `main.ts`. */
export function loadEnvOrExit<V extends Record<string, EnvVarSpec>>(
  def: EnvDefinition<V>,
  options?: LoadEnvOptions,
): EnvValues<EnvDefinition<V>> {
  try {
    return loadEnv(def, options);
  } catch (err) {
    if (!(err instanceof EnvError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

/** Returns a copy that is safe to log: secret values are replaced. */
export function redactEnv<V extends Record<string, EnvVarSpec>>(
  def: EnvDefinition<V>,
  values: EnvValues<EnvDefinition<V>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values as Record<string, unknown>).map(([k, v]) => [
      k,
      def.vars[k]?.secret && v !== undefined ? '[redacted]' : v,
    ]),
  );
}
