// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { SIMPLEFIN_BRIDGE_HOSTS, type SimpleFinClientOptions } from './client.js';

/**
 * Where SimpleFIN tokens may point (#91, threat model T28), as env specs for `defineEnv`, so the
 * api and the worker read them the same way. Whether SimpleFIN is on at all is the instance
 * setting `simplefin.enabled` (#400).
 */
export const simpleFinEnvVars = {
  SIMPLEFIN_BRIDGE_HOSTS: {
    schema: z
      .string()
      .regex(/^[a-z0-9.-]+(\s*,\s*[a-z0-9.-]+)*$/i, 'a comma-separated list of host names')
      .optional(),
    description:
      'Hosts a SimpleFIN setup token may point at, comma-separated. Defaults to the Bridge ' +
      '(bridge.simplefin.org, beta-bridge.simplefin.org); a token pointing anywhere else is refused.',
    example: 'bridge.simplefin.org,beta-bridge.simplefin.org',
  },
  SIMPLEFIN_ALLOW_HTTP: {
    schema: z.enum(['true', 'false']).optional(),
    description: 'Tests only: allow tokens on plain http, for a local stub Bridge.',
  },
};

export interface SimpleFinEnv {
  SIMPLEFIN_BRIDGE_HOSTS?: string | undefined;
  SIMPLEFIN_ALLOW_HTTP?: 'true' | 'false' | undefined;
}

export type SimpleFinInstanceConfig = Required<
  Pick<SimpleFinClientOptions, 'allowedHosts' | 'allowHttp'>
>;

/** The hosts tokens may point at, and whether http is allowed (tests only). */
export function instanceSimpleFinConfig(env: SimpleFinEnv): SimpleFinInstanceConfig {
  const hosts = env.SIMPLEFIN_BRIDGE_HOSTS?.split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    allowedHosts: hosts?.length ? hosts : SIMPLEFIN_BRIDGE_HOSTS,
    allowHttp: env.SIMPLEFIN_ALLOW_HTTP === 'true',
  };
}
