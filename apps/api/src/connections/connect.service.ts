// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  credentialsChanged,
  credentialStamp,
  type LinkTokenCreateRequest,
  type PlaidAccount,
  type PlaidClient,
  type PlaidCredentialsResult,
  resolvePlaidCredentials,
} from '@fiscus/aggregation';
import { FieldCrypto } from '@fiscus/crypto';
import {
  accounts,
  aggregationCredentials,
  connections,
  type Executor,
  households,
  institutions,
  readConnectionSecret,
  saveConnectionSecret,
  transactions,
} from '@fiscus/db';
import { accessLevels } from '@fiscus/ledger';
import {
  type ConnectionConfirmed,
  type ConnectionSetup,
  type confirmConnectionSchema,
  type BankAlreadyConnected,
  type ConnectSuggestion,
  matchAccounts,
  type OfferedAccount,
  type PlaidAvailability,
  type PlaidLinkExit,
  type PlaidLinkToken,
  type plaidExchangeSchema,
} from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { AccountsService, STYLE_VISIBILITY } from '../accounts/accounts.service.js';
import { violatedConstraint } from '../common/db-errors.js';
import { addDays, todayIn } from '../common/dates.js';
import { Problem, type ProblemFieldError, problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import {
  accountNameFrom,
  LINK_CLIENT_NAME,
  LINK_CONSENTED_PRODUCTS,
  LINK_COUNTRY_CODES,
  LINK_DAYS_REQUESTED,
  LINK_PRODUCTS,
  linkRedirect,
  plaidAccountType,
  plaidClientFor,
  plaidClientUserId,
  plaidCurrentBalance,
  plaidMask,
  plaidProblem,
} from './plaid.js';

type ConfirmInput = z.infer<typeof confirmConnectionSchema>;
type ExchangeInput = z.infer<typeof plaidExchangeSchema>;

/** How far back a new account's first sync starts (D6); Plaid keeps up to 730 days for #80. */
const NEW_ACCOUNT_DAYS = 90;
/** A linked account syncs from this long before its history ends, so the overlap matches (D6). */
const LINKED_OVERLAP_DAYS = 7;

const notInSetup = () =>
  new Problem(
    409,
    'not_in_setup',
    'This connection is already set up',
    'Its accounts were chosen already. Change them from the connection’s settings.',
  );

/**
 * Connecting a bank through Plaid Link (#79, the bank connections walkthrough §2–§3): the link
 * token, the exchange, and choosing what each account becomes. A new connection stays in `setup`,
 * seen only by the member who connected it and never synced, until they confirm owners and
 * visibility (D4). Clearing setups that are never confirmed is left to #81.
 *
 * The access token is stored encrypted (connection_secrets) and never returned, logged or put in
 * an error. Accounts and the institution come from Plaid's api, never Link's metadata.
 */
@Injectable()
export class ConnectService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
    private readonly accountsService: AccountsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Whether the household can connect a bank through Plaid now, and in which environment. */
  async availability(ctx: HouseholdContext): Promise<PlaidAvailability> {
    const result = await this.#householdCredentials(ctx);
    return result.available
      ? { available: true, env: result.credentials.env }
      : { available: false, reason: result.reason };
  }

  /**
   * A link token (ACC-01). With `connectionId`, for update mode (re-auth, ACC-03): only the
   * connection's owner, with the Item's own keys.
   */
  async linkToken(ctx: HouseholdContext, connectionId?: string): Promise<PlaidLinkToken> {
    const base = {
      client_name: LINK_CLIENT_NAME,
      language: 'en',
      country_codes: LINK_COUNTRY_CODES,
      user: { client_user_id: plaidClientUserId(ctx.memberId) },
      ...linkRedirect(this.config.plaid),
    };
    let client: PlaidClient;
    let request: LinkTokenCreateRequest;
    if (connectionId === undefined) {
      ({ client } = plaidClientFor(await this.#householdCredentials(ctx)));
      request = {
        ...base,
        products: LINK_PRODUCTS,
        additional_consented_products: LINK_CONSENTED_PRODUCTS,
        transactions: { days_requested: LINK_DAYS_REQUESTED },
      };
    } else {
      const own = await this.#ownConnection(ctx, connectionId, { update: true });
      client = own.client;
      // Update mode names the Item; products and history were fixed when it was made.
      request = { ...base, access_token: own.secret };
    }
    const token = await client.linkTokenCreate(request).catch(plaidProblem);
    return { linkToken: token.link_token, expiration: token.expiration };
  }

  /**
   * Exchanges Link's public token once, and records the connection in `setup` with the caller as
   * its owner. Returns the accounts the bank offers, each with a suggested choice.
   */
  async exchange(ctx: HouseholdContext, input: ExchangeInput): Promise<ConnectionSetup> {
    const { client, credentials } = plaidClientFor(await this.#householdCredentials(ctx));
    // Before the exchange, which is when Plaid starts billing for the Item (ITEM-011).
    if (input.link && !input.duplicateOk) await this.#refuseDuplicate(ctx, input.link);
    const { access_token: secret, item_id: itemId } = await client
      .itemPublicTokenExchange(input.publicToken)
      .catch(plaidProblem);

    let offered: PlaidAccount[];
    let institution: { id: string; name: string; url: string | null } | null = null;
    try {
      const got = await client.accountsGet(secret);
      offered = got.accounts;
      if (got.item.institution_id) {
        const { institution: i } = await client.institutionsGetById(
          got.item.institution_id,
          LINK_COUNTRY_CODES,
        );
        institution = { id: i.institution_id, name: i.name, url: i.url ?? null };
      }
    } catch (err) {
      // Nothing is stored yet, so the Item would be orphaned (and billed): end it at Plaid.
      await removeQuietly(client, secret);
      plaidProblem(err);
    }

    const id = uuidv7();
    try {
      return await this.scope.run(ctx, async (tx, activity) => {
        let institutionId: string | null = null;
        if (institution) {
          const [row] = await tx
            .insert(institutions)
            .values({
              provider: 'plaid',
              providerInstitutionId: institution.id,
              name: institution.name,
              url: institution.url,
            })
            .onConflictDoUpdate({
              target: [institutions.provider, institutions.providerInstitutionId],
              set: { name: institution.name, url: institution.url, updatedAt: new Date() },
            })
            .returning({ id: institutions.id });
          institutionId = row!.id;
        }
        await tx.insert(connections).values({
          id,
          householdId: ctx.householdId,
          ownerMemberId: ctx.memberId,
          provider: 'plaid',
          institutionId,
          // The server's keys: a household's own (#83) are refused above until they're built.
          credentialSetId: null,
          providerItemId: itemId,
          ...credentialStamp(credentials),
          status: 'setup',
          nextSyncAt: null,
        });
        await saveConnectionSecret(tx, this.crypto, ctx.householdId, id, secret);
        // Only its owner sees it until they confirm (D4): "connection added" is recorded then.
        await activity.record({
          action: 'connection.setup_started',
          targetType: 'connection',
          targetId: id,
          metadata: {
            provider: 'plaid',
            ...(input.link && { linkSessionId: input.link.sessionId }),
            ...(input.link?.institutionId && { institutionId: input.link.institutionId }),
          },
          visibleToHousehold: false,
        });
        return {
          connectionId: id,
          institutionName: institution?.name ?? null,
          accounts: await this.#offer(tx, ctx, offered),
        };
      });
    } catch (err) {
      if (violatedConstraint(err) === 'connections_provider_item') {
        // The same Item, already connected: keep it working, so don't remove it.
        throw new Problem(409, 'already_connected', 'This bank login is already connected');
      }
      await removeQuietly(client, secret);
      throw err;
    }
  }

  /**
   * Link closed without connecting a bank. Recorded only for the caller, with Plaid's codes (never
   * its messages), so a failure can be traced with Plaid's support by its session id.
   */
  async linkExit(ctx: HouseholdContext, exit: PlaidLinkExit): Promise<void> {
    await this.scope.run(ctx, async (_tx, activity) => {
      await activity.record({
        action: 'connection.link_exited',
        metadata: {
          provider: 'plaid',
          linkSessionId: exit.sessionId,
          ...(exit.status && { status: exit.status }),
          ...(exit.institutionId && { institutionId: exit.institutionId }),
          ...(exit.errorType && { errorType: exit.errorType }),
          ...(exit.errorCode && { errorCode: exit.errorCode }),
          ...(exit.requestId && { requestId: exit.requestId }),
        },
        visibleToHousehold: false,
      });
    });
  }

  /**
   * Refuses a second connection to accounts the caller already connected at this bank: Plaid
   * bills each Item, and never notices the duplicate itself. By Link's word (its institution and
   * the accounts' last 4 digits and subtypes), so only as a warning: `duplicateOk` goes ahead. A
   * setup left unfinished at the bank counts too, as finishing it is what was meant.
   */
  async #refuseDuplicate(
    ctx: HouseholdContext,
    link: NonNullable<ExchangeInput['link']>,
  ): Promise<void> {
    if (!link.institutionId) return;
    const institutionId = link.institutionId;
    const found = await this.scope.run(ctx, async (tx) => {
      const mine = await tx
        .select({ id: connections.id, status: connections.status })
        .from(connections)
        .innerJoin(institutions, eq(institutions.id, connections.institutionId))
        .where(
          and(
            eq(connections.householdId, ctx.householdId),
            eq(connections.ownerMemberId, ctx.memberId),
            eq(connections.provider, 'plaid'),
            ne(connections.status, 'disconnected'),
            eq(institutions.providerInstitutionId, institutionId),
          ),
        );
      const setup = mine.find((c) => c.status === 'setup');
      if (setup) return setup;
      const live = mine.filter((c) => c.status !== 'setup');
      if (!live.length) return undefined;
      const subtypeOf = (s: string | null | undefined) => s?.trim().toLowerCase() || null;
      const offered = link.accounts.flatMap((a) => {
        const mask = plaidMask(a.mask);
        return mask ? [{ mask, subtype: subtypeOf(a.subtype) }] : [];
      });
      // The same last 4 digits, and the same subtype unless either has none (a linked account
      // keeps the subtype it had here).
      const matches = (mask: string, subtype: string | null) =>
        offered.some(
          (o) =>
            o.mask === mask && (o.subtype === null || subtype === null || o.subtype === subtype),
        );
      const tracked = await tx
        .select({
          connectionId: accounts.connectionId,
          mask: accounts.maskLast4,
          subtype: accounts.subtype,
        })
        .from(accounts)
        .where(
          inArray(
            accounts.connectionId,
            live.map((c) => c.id),
          ),
        );
      const same = tracked.find((a) => a.mask && matches(a.mask, subtypeOf(a.subtype)));
      return same ? live.find((c) => c.id === same.connectionId) : undefined;
    });
    if (!found) return;
    const extensions: BankAlreadyConnected = {
      connectionId: found.id,
      status: found.status as BankAlreadyConnected['status'],
    };
    throw new Problem(
      409,
      'bank_already_connected',
      'You’ve connected this bank already',
      found.status === 'setup'
        ? 'Finish choosing its accounts instead.'
        : 'Its accounts sync through your existing connection. To fix it, sign in to the bank again there.',
      undefined,
      {},
      { ...extensions },
    );
  }

  /** The accounts offered again, for a setup still in progress (the page was reloaded). */
  async setup(ctx: HouseholdContext, connectionId: string): Promise<ConnectionSetup> {
    const own = await this.#ownConnection(ctx, connectionId, { setup: true });
    const { accounts: offered } = await own.client.accountsGet(own.secret).catch(plaidProblem);
    return this.scope.run(ctx, async (tx) => ({
      connectionId,
      institutionName: own.institutionName,
      accounts: await this.#offer(tx, ctx, offered),
    }));
  }

  /**
   * Confirms what each offered account becomes (D4, D5): linked to one of the caller's accounts,
   * a new account with its owners and visibility, or not tracked. Only the connection's owner,
   * only while it's in `setup`. Then it's `ok` and due now, so the worker syncs it right away.
   */
  async confirm(
    ctx: HouseholdContext,
    connectionId: string,
    input: ConfirmInput,
  ): Promise<ConnectionConfirmed> {
    const own = await this.#ownConnection(ctx, connectionId, { setup: true });
    const { accounts: offered } = await own.client.accountsGet(own.secret).catch(plaidProblem);

    return this.scope.run(ctx, async (tx, activity) => {
      const [c] = await tx
        .select({ status: connections.status })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for('update');
      if (c?.status !== 'setup') throw notInSetup();

      const choices = new Map(input.accounts.map((a) => [a.providerAccountId, a]));
      const offeredIds = new Set(offered.map((a) => a.account_id));
      const errors: ProblemFieldError[] = [
        ...offered
          .filter((a) => !choices.has(a.account_id))
          .map((a) => ({
            path: 'accounts',
            code: 'missing_choice',
            message: `No choice for ${a.account_id}`,
          })),
        ...input.accounts
          .filter((a) => !offeredIds.has(a.providerAccountId))
          .map((a) => ({
            path: 'accounts',
            code: 'not_offered',
            message: `The bank doesn't offer ${a.providerAccountId}`,
          })),
      ];
      if (errors.length) {
        throw new Problem(
          422,
          'choices_mismatch',
          'Choose once for each account the bank offers',
          undefined,
          errors,
        );
      }
      if (input.accounts.every((a) => a.choice === 'skip')) {
        throw new Problem(
          422,
          'nothing_tracked',
          'Choose at least one account to track',
          'To track none, disconnect the bank instead.',
        );
      }
      const linkIds = input.accounts.flatMap((a) => (a.choice === 'link' ? [a.accountId] : []));
      if (new Set(linkIds).size !== linkIds.length) {
        throw new Problem(422, 'linked_twice', 'Each of your accounts can be linked to one only');
      }

      const [hh] = await tx
        .select({ timezone: households.timezone, baseCurrency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, ctx.householdId));
      const today = todayIn(hh!.timezone);
      const levels = await accessLevels(tx);
      const linkRows = linkIds.length
        ? await tx.select().from(accounts).where(inArray(accounts.id, linkIds)).for('update')
        : [];
      const latest = new Map(
        linkIds.length
          ? (
              await tx
                .select({
                  accountId: transactions.accountId,
                  last: max(
                    sql<string>`coalesce(${transactions.postedDate}, ${transactions.authorizedDate})`,
                  ),
                })
                .from(transactions)
                .where(inArray(transactions.accountId, linkIds))
                .groupBy(transactions.accountId)
            ).map((r) => [r.accountId, r.last])
          : [],
      );

      const tracked: ConnectionConfirmed['accounts'] = [];
      for (const bank of offered) {
        const choice = choices.get(bank.account_id)!;
        if (choice.choice === 'skip') continue;
        const mask = plaidMask(bank.mask);
        const currency = bank.balances.iso_currency_code ?? hh!.baseCurrency;
        let accountId: string;
        let syncFrom: string;
        if (choice.choice === 'link') {
          // Locked rows are the caller's own: one they only see isn't among them.
          const level = levels.get(choice.accountId);
          if (level && level !== 'owner') {
            throw problems.forbidden('You can only link a bank account to an account you own.');
          }
          const row = linkRows.find((r) => r.id === choice.accountId);
          if (!row) throw new Problem(422, 'invalid_account', 'That account doesn’t exist');
          if (row.connectionId !== null) {
            throw new Problem(
              409,
              'account_already_connected',
              'That account already syncs from a bank',
              'Disconnect that bank from it first, or choose another account.',
            );
          }
          if (row.currency !== currency) {
            throw new Problem(
              422,
              'currency_mismatch',
              'That account is in another currency',
              `The bank's account is in ${currency}, yours in ${row.currency}.`,
            );
          }
          accountId = row.id;
          // History stays (D5); sync starts a week before it ends, so the overlap is matched (D6).
          const last = latest.get(row.id);
          syncFrom = last ? addDays(last, -LINKED_OVERLAP_DAYS) : addDays(today, -NEW_ACCOUNT_DAYS);
          const setMask = row.maskLast4 === null && mask !== null;
          const version = row.version + 1;
          await tx
            .update(accounts)
            .set({
              connectionId,
              providerAccountId: bank.account_id,
              syncFrom,
              ...(setMask
                ? { maskLast4: mask, fieldVersions: { ...row.fieldVersions, mask: version } }
                : {}),
              version,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, row.id));
        } else {
          accountId = await this.accountsService.createWithin(tx, activity, ctx, {
            name: choice.name ?? accountNameFrom(bank),
            type: plaidAccountType(bank.type),
            ...(bank.subtype?.trim() ? { subtype: bank.subtype.trim().slice(0, 60) } : {}),
            currency,
            ...(mask ? { mask } : {}),
            // The connecting member owns new accounts unless they say otherwise (ACC-01, D4).
            owners: choice.owners ?? [{ memberId: ctx.memberId }],
            ...(choice.visibility ? { visibility: choice.visibility } : {}),
          });
          syncFrom = addDays(today, -NEW_ACCOUNT_DAYS);
          await tx
            .update(accounts)
            .set({
              connectionId,
              providerAccountId: bank.account_id,
              officialName: bank.official_name?.trim() || null,
              syncFrom,
            })
            .where(eq(accounts.id, accountId));
        }
        tracked.push({
          providerAccountId: bank.account_id,
          accountId,
          linked: choice.choice === 'link',
          syncFrom,
        });
        // One event per account, seen by exactly those who see it. No names or numbers.
        await activity.record({
          action: 'connection.added',
          targetType: 'connection',
          targetId: connectionId,
          accountId,
          metadata: { provider: 'plaid', linked: choice.choice === 'link' },
        });
      }

      // Due now: the runner (#81) claims it on its next pass, and the first sync starts.
      await tx
        .update(connections)
        .set({ status: 'ok', nextSyncAt: sql`now()`, updatedAt: new Date() })
        .where(eq(connections.id, connectionId));
      return { connectionId, accounts: tracked };
    });
  }

  /**
   * The keys this household connects new banks with: its own set if it has one (#83), else the
   * server's. Resolved for each request, never once per process (ADR 0008 §Credentials 4).
   */
  #householdCredentials(ctx: HouseholdContext): Promise<PlaidCredentialsResult> {
    return this.scope.run(ctx, async (tx) => {
      const [own] = await tx
        .select({ id: aggregationCredentials.id })
        .from(aggregationCredentials)
        .where(
          and(
            eq(aggregationCredentials.householdId, ctx.householdId),
            eq(aggregationCredentials.provider, 'plaid'),
            isNull(aggregationCredentials.revokedAt),
          ),
        )
        .limit(1);
      return resolvePlaidCredentials(own?.id ?? null, this.config.plaid);
    });
  }

  /**
   * The caller's own Plaid connection, its secret, and a client with the keys it was made with.
   * Someone else's is refused (ACC-03); one they can't see doesn't exist.
   */
  async #ownConnection(
    ctx: HouseholdContext,
    id: string,
    want: { setup?: boolean; update?: boolean },
  ): Promise<{ client: PlaidClient; secret: string; institutionName: string | null }> {
    const found = await this.scope.run(ctx, async (tx) => {
      const [c] = await tx
        .select({
          ownerMemberId: connections.ownerMemberId,
          provider: connections.provider,
          status: connections.status,
          credentialSetId: connections.credentialSetId,
          providerEnv: connections.providerEnv,
          providerClientId: connections.providerClientId,
          institutionName: institutions.name,
        })
        .from(connections)
        .leftJoin(institutions, eq(institutions.id, connections.institutionId))
        .where(and(eq(connections.id, id), eq(connections.householdId, ctx.householdId)));
      if (!c || c.provider !== 'plaid') throw problems.notFound();
      if (c.ownerMemberId !== ctx.memberId) {
        throw problems.forbidden('Only the person who connected it can do this.');
      }
      if (want.setup && c.status !== 'setup') throw notInSetup();
      if (want.update && (c.status === 'setup' || c.status === 'disconnected')) {
        throw new Problem(
          409,
          c.status === 'setup' ? 'connection_in_setup' : 'connection_disconnected',
          c.status === 'setup'
            ? 'Choose this connection’s accounts first'
            : 'This connection is disconnected',
        );
      }
      const secret = await readConnectionSecret(tx, this.crypto, ctx.householdId, id);
      return { ...c, secret };
    });
    if (found.secret === null) {
      throw new Problem(409, 'connection_gone', 'This connection has no stored access');
    }
    const { client, credentials } = plaidClientFor(
      resolvePlaidCredentials(found.credentialSetId, this.config.plaid),
    );
    if (
      found.providerEnv !== null &&
      found.providerClientId !== null &&
      credentialsChanged(
        { providerEnv: found.providerEnv, providerClientId: found.providerClientId },
        credentials,
      )
    ) {
      throw new Problem(
        409,
        'credentials_changed',
        'This connection was made with other Plaid keys',
        'Disconnect it and connect the bank again.',
      );
    }
    return { client, secret: found.secret, institutionName: found.institutionName };
  }

  /** The bank's accounts, each with a suggested choice for the caller (the walkthrough §3). */
  async #offer(
    tx: Executor,
    ctx: HouseholdContext,
    offered: PlaidAccount[],
  ): Promise<OfferedAccount[]> {
    const [hh] = await tx
      .select({ financeStyle: households.financeStyle, baseCurrency: households.baseCurrency })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    const levels = await accessLevels(tx);
    const ownedIds = [...levels].filter(([, level]) => level === 'owner').map(([id]) => id);
    // Only the caller's accounts (nobody connects into someone else's), and only ones no other
    // connection syncs.
    const candidates = ownedIds.length
      ? await tx
          .select({
            id: accounts.id,
            name: accounts.name,
            type: accounts.type,
            mask: accounts.maskLast4,
            currency: accounts.currency,
            closedAt: accounts.closedAt,
          })
          .from(accounts)
          .where(and(inArray(accounts.id, ownedIds), isNull(accounts.connectionId)))
      : [];
    const closed = new Set(candidates.filter((c) => c.closedAt).map((c) => c.id));
    const matches = matchAccounts(
      offered.map((a) => ({
        names: [a.name, a.official_name ?? ''],
        type: plaidAccountType(a.type),
        mask: plaidMask(a.mask),
        currency: a.balances.iso_currency_code ?? null,
      })),
      candidates.map((c) => ({ ...c, closedAt: c.closedAt?.toISOString() ?? null })),
    );
    const visibility = STYLE_VISIBILITY[hh!.financeStyle] ?? 'full';
    return offered.map((a, i): OfferedAccount => {
      const match = matches[i];
      const suggestion: ConnectSuggestion = !match
        ? { choice: 'new', owners: [{ memberId: ctx.memberId }], visibility }
        : closed.has(match.accountId)
          ? { choice: 'skip', reason: 'closed', accountId: match.accountId }
          : { choice: 'link', accountId: match.accountId, by: match.by };
      return {
        providerAccountId: a.account_id,
        name: a.name,
        officialName: a.official_name ?? null,
        type: plaidAccountType(a.type),
        subtype: a.subtype ?? null,
        mask: plaidMask(a.mask),
        currency: a.balances.iso_currency_code ?? hh!.baseCurrency,
        balance: plaidCurrentBalance(a),
        suggestion,
      };
    });
  }
}

/** Ends an Item at Plaid, ignoring failure: for an exchange whose connection wasn't stored. */
async function removeQuietly(client: PlaidClient, secret: string): Promise<void> {
  await client.itemRemove(secret).catch(() => undefined);
}
