import { z } from 'zod';
import { type CurrentUser, displayNameSchema, emailSchema } from './auth.js';

const currencies = new Set(Intl.supportedValuesOf('currency'));
const timeZones = new Set(Intl.supportedValuesOf('timeZone'));

export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((c) => currencies.has(c), 'Unknown ISO 4217 currency code');

export const timeZoneSchema = z
  .string()
  .refine((tz) => timeZones.has(tz) || tz === 'UTC', 'Unknown IANA time zone');

export const memberRoleSchema = z.enum(['owner', 'member', 'viewer']);
export type MemberRole = z.infer<typeof memberRoleSchema>;
export const financeStyleSchema = z.enum(['combined', 'hybrid', 'separate', 'roommates']);
export const dateBasisSchema = z.enum(['posted', 'authorized']);

const householdSettings = {
  name: z.string().trim().min(1).max(80),
  baseCurrency: currencyCodeSchema,
  timezone: timeZoneSchema,
  weekStart: z.number().int().min(0).max(6),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  dateBasis: dateBasisSchema,
  financeStyle: financeStyleSchema,
};

export const createHouseholdSchema = z.object({
  ...householdSettings,
  weekStart: householdSettings.weekStart.default(1),
  fiscalYearStartMonth: householdSettings.fiscalYearStartMonth.default(1),
  dateBasis: householdSettings.dateBasis.default('posted'),
  financeStyle: householdSettings.financeStyle.default('hybrid'),
  /** How the creator appears in this household. Defaults to their account display name. */
  displayName: displayNameSchema.optional(),
});

export const updateHouseholdSchema = z.object(householdSettings).partial().strict();

export const createInviteSchema = z.object({
  email: emailSchema,
  role: memberRoleSchema.default('member'),
});

export const changeRoleSchema = z.object({ role: memberRoleSchema });

export const inviteSignupSchema = z.object({
  password: z.string().min(12, 'Use at least 12 characters').max(256),
  displayName: displayNameSchema,
});

export interface Household {
  id: string;
  name: string;
  baseCurrency: string;
  timezone: string;
  weekStart: number;
  fiscalYearStartMonth: number;
  dateBasis: 'posted' | 'authorized';
  financeStyle: 'combined' | 'hybrid' | 'separate' | 'roommates';
  status: 'active' | 'disabled' | 'deleting';
  version: number;
  you: { memberId: string; role: MemberRole };
}

export interface HouseholdMember {
  id: string;
  displayName: string;
  color: string;
  role: MemberRole;
  joinedAt: string;
  isYou: boolean;
  /** Only shown to household owners (permissions HH-03). */
  email?: string;
}

export interface Membership {
  householdId: string;
  householdName: string;
  memberId: string;
  role: MemberRole;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: MemberRole;
  expiresAt: string;
  createdAt: string;
}

export interface InvitePreview {
  householdName: string;
  invitedBy: string | null;
  email: string;
  role: MemberRole;
  accountExists: boolean;
}

export interface Me extends CurrentUser {
  memberships: Membership[];
}
