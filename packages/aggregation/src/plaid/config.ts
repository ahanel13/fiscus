// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/** Plaid's environments Fiscus uses: sandbox for tests and trying it out, production for banks (D17). */
export const PLAID_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PlaidEnvironment = (typeof PLAID_ENVIRONMENTS)[number];

export const PLAID_BASE_URLS: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

/**
 * Where requests go. The override is for tests (a fake Plaid server) and is honored only in
 * sandbox, so production keys can never be sent to another host.
 */
export const plaidBaseUrl = (env: PlaidEnvironment, override?: string): string =>
  env === 'sandbox' && override ? override.replace(/\/+$/, '') : PLAID_BASE_URLS[env];

/**
 * The server's own Plaid keys (ADR 0008 §Credentials 1, #82), as env specs for `defineEnv`, so
 * the api and the worker read them the same way. Each also works as `NAME_FILE`. All optional
 * here: whether they're set together is checked after loading, by `instancePlaidConfig`.
 */
export const plaidEnvVars = {
  PLAID_CLIENT_ID: {
    schema: z.string().min(1).optional(),
    description:
      "The server's Plaid client id. Set PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV together, " +
      'or none: without them, Plaid is unavailable unless a household has its own keys.',
  },
  PLAID_SECRET: {
    schema: z.string().min(1).optional(),
    description: "The server's Plaid secret, for PLAID_ENV's environment.",
    secret: true,
  },
  PLAID_ENV: {
    schema: z.enum(PLAID_ENVIRONMENTS).optional(),
    description:
      'Plaid environment: sandbox (test data only) or production (real banks). Run sandbox as a ' +
      'separate instance rather than switching a real one (README, Plaid keys).',
  },
  PLAID_REDIRECT_URI: {
    schema: z.url({ protocol: /^https$/, error: 'must be an https URL' }).optional(),
    description:
      "Optional: the https URL Plaid Link returns to after a bank's own sign-in page (OAuth). " +
      "It must also be listed in Plaid's dashboard.",
  },
  PLAID_API_BASE_URL: {
    schema: z.url().optional(),
    description:
      "Tests only: send Plaid requests to this URL instead of Plaid's. Ignored unless PLAID_ENV=sandbox.",
  },
};

export interface PlaidEnv {
  PLAID_CLIENT_ID?: string | undefined;
  PLAID_SECRET?: string | undefined;
  PLAID_ENV?: PlaidEnvironment | undefined;
  PLAID_REDIRECT_URI?: string | undefined;
  PLAID_API_BASE_URL?: string | undefined;
}

/** The server's Plaid keys, once loaded. The secret is never logged. */
export interface PlaidInstanceConfig {
  clientId: string;
  secret: string;
  env: PlaidEnvironment;
  redirectUri?: string;
  /** The test-only override, present only in sandbox. */
  apiBaseUrl?: string;
}

/** Plaid settings that can't work, found at startup. Names variables, never values. */
export class PlaidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaidConfigError';
  }
}

const REQUIRED = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'] as const;

/**
 * The server's Plaid keys from the loaded env, or undefined when none of the three are set
 * (Plaid is then unavailable unless a household has its own keys, #83). With only some set it
 * throws a PlaidConfigError naming the missing ones. `warn` hears about settings that are ignored.
 */
export function instancePlaidConfig(
  env: PlaidEnv,
  warn: (message: string) => void = () => {},
): PlaidInstanceConfig | undefined {
  const missing = REQUIRED.filter((name) => env[name] === undefined);
  if (missing.length === REQUIRED.length) {
    for (const name of ['PLAID_REDIRECT_URI', 'PLAID_API_BASE_URL'] as const) {
      if (env[name] !== undefined) warn(`${name} is ignored: Plaid is not configured.`);
    }
    return undefined;
  }
  if (missing.length > 0) {
    throw new PlaidConfigError(
      `Set PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV together, or none. Missing: ${missing.join(', ')}.`,
    );
  }
  const config: PlaidInstanceConfig = {
    clientId: env.PLAID_CLIENT_ID!,
    secret: env.PLAID_SECRET!,
    env: env.PLAID_ENV!,
  };
  if (env.PLAID_REDIRECT_URI !== undefined) config.redirectUri = env.PLAID_REDIRECT_URI;
  if (env.PLAID_API_BASE_URL !== undefined) {
    if (config.env === 'sandbox') config.apiBaseUrl = env.PLAID_API_BASE_URL;
    else warn('PLAID_API_BASE_URL is ignored: it applies only when PLAID_ENV=sandbox.');
  }
  return config;
}

/** The one startup line about Plaid: whether it's configured, and the environment. No values. */
export const plaidStatus = (config: PlaidInstanceConfig | undefined): string =>
  config ? `Plaid: configured (${config.env})` : 'Plaid: not configured';

/**
 * The server's Plaid keys, or exit: a PlaidConfigError is logged (it holds no value) and the
 * process stops, as `masterKeysOrExit` does for the master key.
 */
export function instancePlaidConfigOrExit(
  env: PlaidEnv,
  log: { warn: (message: string) => void; fatal: (message: string) => void },
): PlaidInstanceConfig | undefined {
  try {
    return instancePlaidConfig(env, log.warn);
  } catch (err) {
    if (!(err instanceof PlaidConfigError)) throw err;
    log.fatal(err.message);
    return process.exit(1);
  }
}
