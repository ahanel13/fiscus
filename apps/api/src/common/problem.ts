import { HttpException } from '@nestjs/common';

export interface ProblemFieldError {
  path: string;
  code: string;
  message: string;
}

/**
 * An RFC 9457 problem (API conventions §4). `code` is the stable identifier clients branch on.
 */
export class Problem extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: ProblemFieldError[],
    readonly headers: Record<string, string> = {},
  ) {
    super({ code, title, detail }, status);
  }
}

export const problems = {
  unauthenticated: () => new Problem(401, 'unauthenticated', 'Sign in to continue'),
  forbidden: (detail?: string) =>
    new Problem(403, 'forbidden', 'You are not allowed to do this', detail),
  notFound: () => new Problem(404, 'not_found', 'Not found'),
  csrf: () =>
    new Problem(
      403,
      'csrf_failed',
      'Missing or invalid CSRF token',
      'Fetch a token from GET /api/v1/auth/csrf and send it as X-CSRF-Token.',
    ),
  reauthRequired: () =>
    new Problem(403, 'reauth_required', 'Confirm your password to continue', undefined),
  rateLimited: (retryAfterSeconds: number) =>
    new Problem(429, 'rate_limited', 'Too many attempts, try again later', undefined, undefined, {
      'retry-after': String(retryAfterSeconds),
    }),
};
