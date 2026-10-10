// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// Request schemas for /api/v1/auth and /api/v1/me (API conventions, docs/design/api-conventions.md).

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }).max(254));

/** The fewest characters a new password may have. */
export const PASSWORD_MIN_LENGTH = 15;

/** What a new password needs, each with how to say it's missing. */
export const PASSWORD_RULES = [
  {
    id: 'length',
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (p: string) => [...p].length >= PASSWORD_MIN_LENGTH,
  },
  { id: 'upper', label: 'An uppercase letter', test: (p: string) => /\p{Lu}/u.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: (p: string) => /\p{Ll}/u.test(p) },
  { id: 'number', label: 'A number', test: (p: string) => /\p{N}/u.test(p) },
  {
    id: 'symbol',
    label: 'A symbol (like ! or #)',
    test: (p: string) => /[^\p{L}\p{N}\s]/u.test(p),
  },
] as const;

/** The rules `password` doesn't meet yet, in order. */
export const passwordMissing = (password: string) =>
  PASSWORD_RULES.filter((r) => !r.test(password));

/** What a new password still needs, in a sentence, or null when it meets the policy. */
export function passwordProblem(password: string): string | null {
  const missing = passwordMissing(password);
  return missing.length
    ? `Your password needs: ${missing.map((r) => r.label.toLowerCase()).join(', ')}.`
    : null;
}

/**
 * A new password: at least 15 characters, with an uppercase letter, a lowercase letter, a number,
 * and a symbol. Signing in doesn't apply it, so passwords set before it still work. The upper
 * bound prevents hashing abuse.
 */
export const passwordSchema = z
  .string()
  .max(256, 'Use at most 256 characters')
  .superRefine((password, ctx) => {
    const message = passwordProblem(password);
    if (message) ctx.addIssue({ code: 'custom', message });
  });

export const displayNameSchema = z.string().trim().min(1).max(80);

export const signupModeSchema = z.enum(['open', 'invite_only', 'closed']);
export type SignupMode = z.infer<typeof signupModeSchema>;

export const setupRequestSchema = z.object({
  setupToken: z.string().min(1),
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Login doesn't enforce the policy, so users created under older rules can still sign in.
  password: z.string().min(1).max(256),
});

export const reauthRequestSchema = z.object({ password: z.string().min(1).max(256) });

export const passwordResetRequestSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export interface AuthStatus {
  setupRequired: boolean;
  signupMode: SignupMode;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  isInstanceAdmin: boolean;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

// ── Server invites (ADM-08) ──────────────────────────────────────────────────────────────────

/** An instance admin invites someone to make an account here, even when signup is invite-only. */
export const createServerInviteSchema = z.object({ email: emailSchema });

export interface ServerInvite {
  id: string;
  email: string;
  /** The admin who sent it, if they still have an account. */
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

/** What the invitee sees before creating their account. */
export interface ServerInvitePreview {
  email: string;
  invitedBy: string | null;
  /** They already have an account: sign in instead. */
  accountExists: boolean;
}

export const joinTokenSchema = z.object({ token: z.string().min(16).max(200) });

/** Creates the invited account; the email comes from the invite. */
export const joinRequestSchema = joinTokenSchema.extend({
  password: passwordSchema,
  displayName: displayNameSchema,
});
