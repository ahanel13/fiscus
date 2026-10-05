// SPDX-License-Identifier: AGPL-3.0-or-later
declare global {
  interface Window {
    __FISCUS_CONFIG__?: { apiUrl?: string; sourceUrl?: string };
  }
}

/** Runtime config written by the container at startup (/env.js, ADR 0003). */
export const apiBase = (): string => (window.__FISCUS_CONFIG__?.apiUrl ?? '').replace(/\/$/, '');

/** Upstream source. A server running a modified Fiscus must point SOURCE_URL at its own source. */
export const UPSTREAM_SOURCE_URL = 'https://github.com/ahanel13/fiscus';

/**
 * Where people using this server can get its source code (AGPL-3.0 §13). Operators who change
 * Fiscus set SOURCE_URL to their modified source; it defaults to upstream.
 */
export const sourceUrl = (): string => window.__FISCUS_CONFIG__?.sourceUrl || UPSTREAM_SOURCE_URL;
