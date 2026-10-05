// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Problem } from './problem.js';

const CODES: Record<number, [code: string, title: string]> = {
  400: ['bad_request', 'The request is malformed'],
  401: ['unauthenticated', 'Sign in to continue'],
  403: ['forbidden', 'You are not allowed to do this'],
  404: ['not_found', 'Not found'],
  405: ['method_not_allowed', 'Method not allowed'],
  413: ['payload_too_large', 'The request body is too large'],
  415: ['unsupported_media_type', 'Send JSON (Content-Type: application/json)'],
  429: ['rate_limited', 'Too many requests'],
};

/** Renders every error as application/problem+json (API conventions §4). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    let status = 500;
    let code = 'internal_error';
    let title = 'Something went wrong';
    let detail: string | undefined;
    let errors: Problem['errors'];
    let headers: Record<string, string> = {};
    let extensions: Record<string, unknown> = {};

    if (exception instanceof Problem) {
      ({ code, title, detail, errors, headers, extensions } = exception);
      status = exception.getStatus();
    } else if (exception instanceof HttpException || hasStatusCode(exception)) {
      status = exception instanceof HttpException ? exception.getStatus() : exception.statusCode;
      [code, title] = CODES[status] ?? (status < 500 ? ['bad_request', title] : [code, title]);
    }
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : exception);

    void reply
      .status(status)
      .headers(headers)
      .type('application/problem+json')
      .send({
        type: `/problems/${code}`,
        title,
        status,
        code,
        ...(detail ? { detail } : {}),
        instance: req.id,
        ...(errors ? { errors } : {}),
        ...extensions,
      });
  }
}

function hasStatusCode(e: unknown): e is { statusCode: number } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { statusCode?: unknown }).statusCode === 'number'
  );
}
