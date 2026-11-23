// SPDX-License-Identifier: AGPL-3.0-or-later

// What moving out does with each household table (#253, ADR 0012 step 3). The worker's move job
// (apps/worker move-out) handles each as listed; member-moves.test.ts fails when a table with a
// household_id, or an encrypted column, isn't listed here, so the job's coverage grows with the
// schema (ADR 0012, Definition of Done).

/**
 * - `moves`: the person's rows go to the new household, with their ids.
 * - `copied`: the ones their data uses are copied into the new household, with new ids.
 * - `stays`: kept by the household they leave (it may lose rows that pointed at moved data).
 * - `household`: about the household itself, not a person's data.
 */
export type MemberMoveRule = 'moves' | 'copied' | 'stays' | 'household';

export const MEMBER_MOVE_TABLES: Record<string, MemberMoveRule> = {
  // The household itself, its members, keys and history: each household keeps its own.
  households: 'household',
  household_members: 'household',
  household_keys: 'household',
  invites: 'household',
  audit_events: 'stays',
  activity_transactions: 'stays',
  member_moves: 'household',
  ownership_claims: 'stays',
  consent_requests: 'stays',
  // Accounts they own alone, and everything under them.
  accounts: 'moves',
  account_owners: 'moves',
  account_owner_periods: 'moves',
  balance_snapshots: 'moves',
  account_liabilities: 'moves',
  transactions: 'moves',
  transaction_attributions: 'moves',
  transaction_tags: 'moves',
  transaction_notes: 'moves',
  attribution_flags: 'stays',
  import_batches: 'moves',
  import_profiles: 'stays',
  recurring_series: 'moves',
  recurring_marks: 'moves',
  recurring_dismissals: 'moves',
  sync_holds: 'moves',
  // Their bank connections made with the server's keys; the household's keys stay (ADR 0008).
  connections: 'moves',
  connection_secrets: 'moves',
  aggregation_credentials: 'stays',
  // Their own budget, goals and rules.
  budgets: 'moves',
  budget_strategies: 'moves',
  budget_amounts: 'moves',
  budget_categories: 'moves',
  budget_moves: 'moves',
  budget_templates: 'moves',
  goals: 'moves',
  goal_claims: 'moves',
  goal_plans: 'moves',
  goal_claim_events: 'moves',
  rules: 'moves',
  // What their data uses, so the new household starts out matching.
  categories: 'copied',
  category_groups: 'copied',
  tags: 'copied',
  // Shared costs are between members of the household they leave (settle-up is finalized first).
  split_policies: 'stays',
  settlements: 'stays',
  income_split_consents: 'stays',
  settle_up_simplify_consents: 'stays',
  funding_targets: 'stays',
  allowances: 'stays',
  // Their arrangement, preferences and notifications start fresh in the new household.
  account_groups: 'stays',
  account_placements: 'stays',
  member_preferences: 'stays',
  notification_channels: 'stays',
  notification_preferences: 'stays',
  notifications: 'stays',
  notification_deliveries: 'stays',
};

/**
 * Encrypted columns of household tables, and what the move does with them: re-encrypted with the
 * new household's key, bound to the new household (ADR 0012 §Mechanism), or kept where they are.
 */
export const MEMBER_MOVE_ENCRYPTED: Record<string, 'reencrypted' | 'stays'> = {
  'accounts.account_number_enc': 'reencrypted',
  'accounts.notes_enc': 'reencrypted',
  'transaction_notes.body_enc': 'reencrypted',
  'connection_secrets.secret_enc': 'reencrypted',
  'aggregation_credentials.secret_enc': 'stays',
  'notification_channels.secret_enc': 'stays',
  'audit_events.changes_enc': 'stays',
};
