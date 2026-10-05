// SPDX-License-Identifier: AGPL-3.0-or-later
import { apiBase } from '../config.js';

/** An RFC 9457 problem from the API (API conventions §4). Branch on `code`, never on text. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors: { path: string; code: string; message: string }[] = [],
    readonly body: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }

  /** The first validation message for a field, for inline form errors. */
  fieldError(path: string): string | undefined {
    return this.errors.find((e) => e.path === path)?.message;
  }

  /** Validation messages keyed by field name, for `<Form validationErrors>`. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.errors) out[e.path] ??= e.message;
    return out;
  }

  /** A problem with no field errors, shown as an alert above the form. */
  get formError(): string | undefined {
    return this.errors.length === 0 ? (this.detail ?? this.title) : undefined;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const UNSAFE = new Set<Method>(['POST', 'PUT', 'PATCH', 'DELETE']);

let csrfToken: string | undefined;
const unauthenticatedListeners = new Set<() => void>();

/** Called when any request comes back 401, so the app can return to the login page. */
export function onUnauthenticated(listener: () => void): () => void {
  unauthenticatedListeners.add(listener);
  return () => unauthenticatedListeners.delete(listener);
}

export function resetCsrf(): void {
  csrfToken = undefined;
}

async function fetchCsrf(): Promise<string> {
  const res = await fetch(`${apiBase()}/api/v1/auth/csrf`, { credentials: 'include' });
  const body = (await res.json()) as { data: { csrfToken: string } };
  csrfToken = body.data.csrfToken;
  return csrfToken;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * JSON API client: same-origin cookies, CSRF on unsafe methods (fetched lazily, refreshed once on
 * `csrf_failed`), CSRF tokens returned by sign-in/out picked up automatically, and problem
 * documents turned into ApiError.
 */
export async function api<T>(
  method: Method,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const send = async (token?: string) =>
    fetch(`${apiBase()}${path}`, {
      method,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { 'x-csrf-token': token } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

  const unsafe = UNSAFE.has(method);
  let res = await send(unsafe ? (csrfToken ?? (await fetchCsrf())) : undefined);
  if (unsafe && res.status === 403) {
    const problem = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string };
    if (problem.code === 'csrf_failed') res = await send(await fetchCsrf());
  }

  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    if (res.status === 401) unauthenticatedListeners.forEach((l) => l());
    throw new ApiError(
      res.status,
      String(json.code ?? 'unknown_error'),
      String(json.title ?? res.statusText),
      json.detail as string | undefined,
      (json.errors as ApiError['errors']) ?? [],
      json,
    );
  }
  const data = (json as { data?: { csrfToken?: string } }).data;
  if (data?.csrfToken) csrfToken = data.csrfToken;
  return json as T;
}
