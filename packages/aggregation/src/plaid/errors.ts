// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderError, type ProviderErrorKind } from '@fiscus/domain';

// Plaid's errors (`error_type`, `error_code`) as Fiscus's error kinds (ITEM-002: never the HTTP
// status or the message). Codes are matched first, then the type; anything else is `transient`,
// retried with backoff rather than marking the connection broken: PRODUCT_NOT_READY (ITEM-006)
// among them, and INSTITUTION_DOWN and INSTITUTION_NOT_RESPONDING as `institution_down` (ITEM-004).

const BY_CODE: Record<string, ProviderErrorKind> = {
  // The bank sign-in needs fixing, in Plaid Link's update mode.
  ITEM_LOGIN_REQUIRED: 'login_required',
  ITEM_LOCKED: 'login_required',
  USER_SETUP_REQUIRED: 'login_required',
  INVALID_CREDENTIALS: 'login_required',
  INVALID_MFA: 'login_required',
  INVALID_UPDATED_USERNAME: 'login_required',
  // The person's consent at the bank (OAuth) has ended, or is about to.
  PENDING_EXPIRATION: 'consent_expired',
  PENDING_DISCONNECT: 'consent_expired',
  ACCESS_NOT_GRANTED: 'consent_expired',
  USER_PERMISSION_REVOKED: 'consent_expired',
  ITEM_CONSENT_EXPIRED: 'consent_expired',
  CONSENT_EXPIRED: 'consent_expired',
  RATE_LIMIT_EXCEEDED: 'rate_limited',
  // The keys, or a token, don't belong to this Plaid account and environment.
  INVALID_API_KEYS: 'invalid_credentials',
  UNAUTHORIZED_ENVIRONMENT: 'invalid_credentials',
  INVALID_ACCESS_TOKEN: 'invalid_credentials',
  INVALID_PUBLIC_TOKEN: 'invalid_credentials',
  // The Item is gone at Plaid (removed, or revoked): unrecoverable, a new Link is needed (ITEM-005).
  ITEM_NOT_FOUND: 'invalid_credentials',
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: 'mutation_during_pagination',
};

const BY_TYPE: Record<string, ProviderErrorKind> = {
  RATE_LIMIT_EXCEEDED: 'rate_limited',
  INSTITUTION_ERROR: 'institution_down',
  API_ERROR: 'transient',
};

/** Plaid codes are SCREAMING_SNAKE_CASE; anything else isn't trusted as safe to log. */
const SAFE_CODE = /^[A-Z0-9_]{1,80}$/;
/** Plaid's request ids are short and alphanumeric; anything else isn't logged. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function plaidErrorKind(errorType: string, errorCode: string): ProviderErrorKind {
  const byCode = BY_CODE[errorCode];
  if (byCode) return byCode;
  if (errorCode.startsWith('INSTITUTION_')) return 'institution_down';
  return BY_TYPE[errorType] ?? 'transient';
}

/** `Retry-After` in seconds (or an HTTP date), as ms. */
function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** A Plaid error response as a ProviderError. Its message stays apart, as untrusted text. */
export function plaidProviderError(
  body: {
    error_type: string;
    error_code: string;
    error_message?: string | null | undefined;
    request_id?: string | undefined;
  },
  retryAfter: string | null,
): ProviderError {
  const kind = plaidErrorKind(body.error_type, body.error_code);
  const retry = kind === 'rate_limited' ? retryAfterMs(retryAfter) : undefined;
  return new ProviderError(kind, {
    providerCode: SAFE_CODE.test(body.error_code) ? body.error_code : 'UNKNOWN',
    ...(retry !== undefined ? { retryAfterMs: retry } : {}),
    // Kept for Plaid's support (DATA-006); only when it looks like one, since it gets logged.
    ...(body.request_id && SAFE_REQUEST_ID.test(body.request_id)
      ? { providerRequestId: body.request_id }
      : {}),
    ...(body.error_message ? { providerMessage: body.error_message } : {}),
  });
}

/** A failure without a Plaid error body: the network, a timeout, or a bare HTTP status. */
export function plaidTransportError(
  providerCode: string,
  options: { status?: number; retryAfter?: string | null } = {},
): ProviderError {
  const kind: ProviderErrorKind = options.status === 429 ? 'rate_limited' : 'transient';
  const retry = kind === 'rate_limited' ? retryAfterMs(options.retryAfter ?? null) : undefined;
  return new ProviderError(kind, {
    providerCode,
    ...(retry !== undefined ? { retryAfterMs: retry } : {}),
  });
}
