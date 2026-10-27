// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  claimSetupToken,
  credentialsChanged,
  credentialStamp,
  type LinkTokenCreateRequest,
  type PlaidAccount,
  type PlaidClient,
  type PlaidCredentialsResult,
  plaidInstitution,
  resolvePlaidCredentials,
  SimpleFinClient,
  simpleFinItemId,
} from '@fiscus/aggregation';
import type { ProviderInstitution } from '@fiscus/domain';
import { FieldCrypto } from '@fiscus/crypto';
import {
  accounts,
  activePlaidKeySet,
  connections,
  type Executor,
  households,
  institutions,
  readConnectionSecret,
  readPlaidKeySet,
  saveConnectionSecret,
  transactions,
} from '@fiscus/db';
import { accessLevels } from '@fiscus/ledger';
import {
  type AccountType,
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
import { and, eq, inArray, isNotNull, isNull, max, ne, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { AccountsService } from '../accounts/accounts.service.js';
import { violatedConstraint } from '../common/db-errors.js';
import { addDays, todayIn } from '../common/dates.js';
import { Problem, type ProblemFieldError, problems } from '../common/problem.js';
import { InstanceSettingsService } from '../admin/instance-settings.service.js';
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
import { disconnectWithin } from './connections.service.js';
import { fromSimpleFin, simpleFinProblem } from './simplefin.js';

type ConfirmInput = z.infer<typeof confirmConnectionSchema>;
type ExchangeInput = z.infer<typeof plaidExchangeSchema>;

/** How far back a new account's first sync starts (D6); Plaid keeps up to 730 days for #80. */
const NEW_ACCOUNT_DAYS = 90;
/** A linked account syncs from this long before its history ends, so the overlap matches (D6). */
const LINKED_OVERLAP_DAYS = 7;

/** An account a bank offers, whoever the provider: what choosing and confirming read (D4, D5). */
interface BankAccount {
  providerAccountId: string;
  /** 1 to 120 characters. */
  name: string;
  officialName: string | null;
  type: AccountType;
  subtype: string | null;
  mask: string | null;
  /** Null when the provider doesn't say: the household's base currency is used. */
  currency: string | null;
  /** The provider's current balance, in Fiscus's sign. */
  balance: { amountMinor: number; currency: string } | null;
}

const fromPlaid = (a: PlaidAccount): BankAccount => ({
  providerAccountId: a.account_id,
  name: accountNameFrom(a),
  officialName: a.official_name?.trim() || null,
  type: plaidAccountType(a.type),
  subtype: a.subtype?.trim() || null,
  mask: plaidMask(a.mask),
  currency: a.balances.iso_currency_code ?? null,
  balance: plaidCurrentBalance(a),
});

/** The connection its owner works on: Plaid's comes with a client for its keys. */
type OwnConnection = { secret: string; institutionName: string | null } & (
  | { provider: 'plaid'; client: PlaidClient; credentialSetId: string | null }
  | { provider: 'simplefin' }
);

const signInAtTheBridge = () =>
  new Problem(
    409,
    'fix_at_the_bridge',
    'SimpleFIN connections are fixed at the SimpleFIN Bridge',
    'Sign in to the bank again at the Bridge, or replace its token.',
  );

const differentBank = () =>
  new Problem(
    422,
    'different_bank',
    'That’s a different bank',
    'To move a bank to new keys, sign in to the same bank it’s connected to now.',
  );

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
    private readonly settings: InstanceSettingsService,
  ) {}

  /** Whether the server's admin has SimpleFIN on (#400). */
  async simpleFinAvailable(): Promise<boolean> {
    return this.settings.get('simplefin.enabled');
  }

  /**
   * Connects the SimpleFIN Bridge with a setup token (#91, D3): claimed once, here, and only the
   * access URL is kept, encrypted with the household key. One connection for the token, however
   * many banks are behind it, in `setup` until its owner chooses what to track (D4), as Plaid's.
   * The token can't be claimed twice, so the connection is stored as soon as it is: if reading
   * the accounts then fails, the setup is still there to come back to.
   */
  async connectSimpleFin(ctx: HouseholdContext, setupToken: string): Promise<ConnectionSetup> {
    if (!(await this.simpleFinAvailable())) {
      throw new Problem(
        409,
        'simplefin_unavailable',
        'SimpleFIN isn’t available on this server',
        'Its admin can turn it on in Server → Bank connections.',
      );
    }
    const options = this.config.simplefin ?? {};
    const secret = await claimSetupToken(setupToken, options).catch(simpleFinProblem);
    const id = uuidv7();
    try {
      await this.scope.run(ctx, async (tx, activity) => {
        const [institution] = await tx
          .insert(institutions)
          .values({
            provider: 'simplefin',
            providerInstitutionId: 'simplefin-bridge',
            name: 'SimpleFIN Bridge',
            url: 'https://beta-bridge.simplefin.org',
          })
          .onConflictDoUpdate({
            target: [institutions.provider, institutions.providerInstitutionId],
            set: { updatedAt: new Date() },
          })
          .returning({ id: institutions.id });
        await tx.insert(connections).values({
          id,
          householdId: ctx.householdId,
          ownerMemberId: ctx.memberId,
          provider: 'simplefin',
          institutionId: institution!.id,
          credentialSetId: null,
          providerItemId: simpleFinItemId(secret),
          status: 'setup',
          nextSyncAt: null,
        });
        await saveConnectionSecret(tx, this.crypto, ctx.householdId, id, secret);
        await activity.record({
          action: 'connection.setup_started',
          targetType: 'connection',
          targetId: id,
          metadata: { provider: 'simplefin' },
          visibleToHousehold: false,
        });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'connections_provider_item') {
        throw new Problem(409, 'already_connected', 'This SimpleFIN token is already connected');
      }
      throw err;
    }
    const set = await new SimpleFinClient(secret, options)
      .accounts({ balancesOnly: true })
      .catch((err: unknown) => {
        // Kept: its owner comes back to it from Accounts once the Bridge answers.
        try {
          simpleFinProblem(err);
        } catch (problem) {
          if (problem instanceof Problem) {
            throw new Problem(
              problem.getStatus(),
              problem.code,
              problem.title,
              'Fiscus kept the connection: choose its accounts once the Bridge answers.',
              undefined,
              problem.headers,
              { ...problem.extensions, connectionId: id },
            );
          }
          throw problem;
        }
        throw err;
      });
    const offered = set.accounts.flatMap((a) => fromSimpleFin(a) ?? []);
    return this.scope.run(ctx, async (tx) => ({
      connectionId: id,
      institutionName: 'SimpleFIN Bridge',
      accounts: await this.#offer(tx, ctx, offered, null),
      replacesConnectionId: null,
    }));
  }

  /** Whether the household can connect a bank through Plaid now, and in which environment. */
  async availability(ctx: HouseholdContext): Promise<PlaidAvailability> {
    const { result, credentialSetId } = await this.#householdCredentials(ctx);
    return result.available
      ? {
          available: true,
          env: result.credentials.env,
          keys: credentialSetId === null ? 'server' : 'household',
        }
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
    };
    // The server's redirect URI is registered in the server's Plaid dashboard only: a household's
    // own keys go without one, and OAuth banks sign in through Link's pop-up (#83).
    const redirect = (credentialSetId: string | null) =>
      credentialSetId === null ? linkRedirect(this.config.plaid) : {};
    let client: PlaidClient;
    let request: LinkTokenCreateRequest;
    if (connectionId === undefined) {
      const keys = await this.#householdCredentials(ctx);
      ({ client } = plaidClientFor(keys.result));
      request = {
        ...base,
        ...redirect(keys.credentialSetId),
        products: LINK_PRODUCTS,
        additional_consented_products: LINK_CONSENTED_PRODUCTS,
        transactions: { days_requested: LINK_DAYS_REQUESTED },
      };
    } else {
      const own = await this.#ownConnection(ctx, connectionId, { update: true });
      if (own.provider !== 'plaid') throw signInAtTheBridge();
      client = own.client;
      // Update mode names the Item; products and history were fixed when it was made.
      request = { ...base, ...redirect(own.credentialSetId), access_token: own.secret };
    }
    const token = await client.linkTokenCreate(request).catch(plaidProblem);
    return { linkToken: token.link_token, expiration: token.expiration };
  }

  /**
   * Exchanges Link's public token once, and records the connection in `setup` with the caller as
   * its owner. Returns the accounts the bank offers, each with a suggested choice. With `replaces`,
   * it moves one of the caller's connections to the keys new banks use now (#83, D15): the same
   * bank, whose accounts it's suggested to take over.
   */
  async exchange(ctx: HouseholdContext, input: ExchangeInput): Promise<ConnectionSetup> {
    const keys = await this.#householdCredentials(ctx);
    const { client, credentials } = plaidClientFor(keys.result);
    const replaced = input.replaces
      ? await this.#replaceable(ctx, input.replaces, keys.credentialSetId)
      : null;
    // Before the exchange, which is when Plaid starts billing for the Item (ITEM-011). A move is
    // meant to reach the same accounts again, at the same bank.
    if (replaced) {
      const said = input.link?.institutionId;
      if (said && replaced.institution && said !== replaced.institution) throw differentBank();
    } else if (input.link && !input.duplicateOk) {
      await this.#refuseDuplicate(ctx, input.link);
    }
    const { access_token: secret, item_id: itemId } = await client
      .itemPublicTokenExchange(input.publicToken)
      .catch(plaidProblem);

    let offered: BankAccount[];
    let institution: ProviderInstitution | null = null;
    try {
      const got = await client.accountsGet(secret);
      offered = got.accounts.map(fromPlaid);
      if (got.item.institution_id) {
        const { institution: i } = await client.institutionsGetById(
          got.item.institution_id,
          LINK_COUNTRY_CODES,
        );
        institution = plaidInstitution(i);
      }
    } catch (err) {
      // Nothing is stored yet, so the Item would be orphaned (and billed): end it at Plaid.
      await removeQuietly(client, secret);
      plaidProblem(err);
    }
    if (replaced?.institution && institution?.providerInstitutionId !== replaced.institution) {
      await removeQuietly(client, secret);
      throw differentBank();
    }

    const id = uuidv7();
    try {
      return await this.scope.run(ctx, async (tx, activity) => {
        let institutionId: string | null = null;
        if (institution) {
          // The bank as Plaid shows it now, with its logo and color (GUIDE-017, #423).
          const display = {
            name: institution.name,
            url: institution.url ?? null,
            logoPng: institution.logoPng ? Buffer.from(institution.logoPng) : null,
            color: institution.color ?? null,
            displayCheckedAt: new Date(),
          };
          const [row] = await tx
            .insert(institutions)
            .values({
              provider: 'plaid',
              providerInstitutionId: institution.providerInstitutionId!,
              ...display,
            })
            .onConflictDoUpdate({
              target: [institutions.provider, institutions.providerInstitutionId],
              set: { ...display, updatedAt: new Date() },
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
          // The keys it was made with, for good: an Item can't move to other keys (ADR 0008).
          credentialSetId: keys.credentialSetId,
          providerItemId: itemId,
          ...credentialStamp(credentials),
          status: 'setup',
          nextSyncAt: null,
          replacesConnectionId: replaced?.id ?? null,
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
            ...(replaced && { replaces: replaced.id }),
          },
          visibleToHousehold: false,
        });
        return {
          connectionId: id,
          institutionName: institution?.name ?? null,
          accounts: await this.#offer(tx, ctx, offered, replaced?.id ?? null),
          replacesConnectionId: replaced?.id ?? null,
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
   * The connection a new one moves to the keys new banks use now (#83, D15): the caller's own,
   * through Plaid, set up and not ended, and made with other keys. Its bank's Plaid id, if known.
   */
  async #replaceable(
    ctx: HouseholdContext,
    id: string,
    newKeys: string | null,
  ): Promise<{ id: string; institution: string | null }> {
    const c = await this.scope.run(ctx, async (tx) => {
      const [row] = await tx
        .select({
          ownerMemberId: connections.ownerMemberId,
          provider: connections.provider,
          status: connections.status,
          credentialSetId: connections.credentialSetId,
          institution: institutions.providerInstitutionId,
        })
        .from(connections)
        .leftJoin(institutions, eq(institutions.id, connections.institutionId))
        .where(and(eq(connections.id, id), eq(connections.householdId, ctx.householdId)));
      return row;
    });
    if (!c) throw problems.notFound();
    if (c.ownerMemberId !== ctx.memberId) {
      throw problems.forbidden('Only the person who connected it can move it.');
    }
    if (c.provider !== 'plaid') {
      throw new Problem(422, 'not_plaid', 'Only a bank connected through Plaid uses Plaid keys');
    }
    if (c.status === 'setup' || c.status === 'disconnected') {
      throw new Problem(
        409,
        c.status === 'setup' ? 'connection_in_setup' : 'connection_disconnected',
        c.status === 'setup'
          ? 'Choose this connection’s accounts first'
          : 'This connection is disconnected',
      );
    }
    if (c.credentialSetId === newKeys) {
      throw new Problem(
        409,
        'same_keys',
        'This bank already uses the keys new banks connect with',
        'There’s nothing to move.',
      );
    }
    return { id, institution: c.institution };
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
    const offered = await this.#offered(own);
    return this.scope.run(ctx, async (tx) => {
      const [c] = await tx
        .select({ replaces: connections.replacesConnectionId })
        .from(connections)
        .where(eq(connections.id, connectionId));
      const replaces = c?.replaces ?? null;
      return {
        connectionId,
        institutionName: own.institutionName,
        accounts: await this.#offer(tx, ctx, offered, replaces),
        replacesConnectionId: replaces,
      };
    });
  }

  /**
   * Confirms what each offered account becomes (D4, D5): linked to one of the caller's accounts,
   * a new account with its owners and visibility, or not tracked. Only the connection's owner,
   * only while it's in `setup`. Then it's `ok` and due now, so the worker syncs it right away.
   *
   * A connection that moves another to new keys (#83) may link that one's accounts, and ends it
   * once they're its own: the worker then ends the old Item at Plaid, with its old keys.
   */
  async confirm(
    ctx: HouseholdContext,
    connectionId: string,
    input: ConfirmInput,
  ): Promise<ConnectionConfirmed> {
    const own = await this.#ownConnection(ctx, connectionId, { setup: true });
    const offered = await this.#offered(own);

    return this.scope.run(ctx, async (tx, activity) => {
      const [c] = await tx
        .select({ status: connections.status, replaces: connections.replacesConnectionId })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for('update');
      if (c?.status !== 'setup') throw notInSetup();
      // Locked before its accounts, as its sync locks it first: a sync running now writes nothing
      // once it's ended. One disconnected since has let go of its accounts already.
      const [old] = c.replaces
        ? await tx
            .select({ status: connections.status })
            .from(connections)
            .where(eq(connections.id, c.replaces))
            .for('update')
        : [];
      const replacing = old && old.status !== 'disconnected' ? c.replaces : null;

      const choices = new Map(input.accounts.map((a) => [a.providerAccountId, a]));
      const offeredIds = new Set(offered.map((a) => a.providerAccountId));
      const errors: ProblemFieldError[] = [
        ...offered
          .filter((a) => !choices.has(a.providerAccountId))
          .map((a) => ({
            path: 'accounts',
            code: 'missing_choice',
            message: `No choice for ${a.providerAccountId}`,
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
        const choice = choices.get(bank.providerAccountId)!;
        if (choice.choice === 'skip') continue;
        const mask = bank.mask;
        const currency = bank.currency ?? hh!.baseCurrency;
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
          if (row.connectionId !== null && row.connectionId !== replacing) {
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
              providerAccountId: bank.providerAccountId,
              syncFrom,
              ...(setMask
                ? { maskLast4: mask, fieldVersions: { ...row.fieldVersions, mask: version } }
                : {}),
              version,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, row.id));
          await releaseEarlier(tx, row.id, syncFrom);
        } else {
          accountId = await this.accountsService.createWithin(tx, activity, ctx, {
            name: choice.name ?? bank.name,
            type: bank.type,
            ...(bank.subtype ? { subtype: bank.subtype.slice(0, 60) } : {}),
            currency,
            ...(mask ? { mask } : {}),
            // The connecting member owns new accounts unless they say otherwise (ACC-01, D4).
            owners: choice.owners ?? [{ memberId: ctx.memberId }],
            // Private unless they chose otherwise; a joint one follows the finance style, since it
            // can't always be private (ADR 0006 §8).
            ...(choice.visibility
              ? { visibility: choice.visibility }
              : (choice.owners?.length ?? 1) === 1
                ? { visibility: 'private' as const }
                : {}),
          });
          syncFrom = addDays(today, -NEW_ACCOUNT_DAYS);
          await tx
            .update(accounts)
            .set({
              connectionId,
              providerAccountId: bank.providerAccountId,
              officialName: bank.officialName,
              syncFrom,
            })
            .where(eq(accounts.id, accountId));
        }
        tracked.push({
          providerAccountId: bank.providerAccountId,
          accountId,
          linked: choice.choice === 'link',
          syncFrom,
        });
        const moved =
          choice.choice === 'link' &&
          replacing !== null &&
          linkRows.find((r) => r.id === accountId)?.connectionId === replacing;
        // One event per account, seen by exactly those who see it. No names or numbers.
        await activity.record({
          action: 'connection.added',
          targetType: 'connection',
          targetId: connectionId,
          accountId,
          metadata: {
            provider: own.provider,
            linked: choice.choice === 'link',
            ...(moved && { moved: true }),
          },
        });
      }
      // Its accounts are this one's now; any left go on without a connection, as on disconnect.
      if (replacing) await disconnectWithin(tx, activity, replacing, 'plaid');

      // Due now: the runner (#81) claims it on its next pass, and the first sync starts.
      await tx
        .update(connections)
        .set({ status: 'ok', nextSyncAt: sql`now()`, updatedAt: new Date() })
        .where(eq(connections.id, connectionId));
      return { connectionId, accounts: tracked };
    });
  }

  /**
   * The keys this household connects new banks with: its own active set if it has one (#83),
   * else the server's. Resolved for each request, never once per process (ADR 0008 §Credentials 4).
   */
  #householdCredentials(
    ctx: HouseholdContext,
  ): Promise<{ result: PlaidCredentialsResult; credentialSetId: string | null }> {
    return this.scope.run(ctx, async (tx) => {
      const own = await activePlaidKeySet(tx, ctx.householdId);
      const keys = own ? await readPlaidKeySet(tx, this.crypto, ctx.householdId, own.id) : null;
      return {
        result: resolvePlaidCredentials(own?.id ?? null, this.config.plaid, keys),
        credentialSetId: own?.id ?? null,
      };
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
  ): Promise<OwnConnection> {
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
      if (!c || (c.provider !== 'plaid' && c.provider !== 'simplefin')) throw problems.notFound();
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
      const householdKeys = c.credentialSetId
        ? await readPlaidKeySet(tx, this.crypto, ctx.householdId, c.credentialSetId)
        : null;
      return { ...c, secret, householdKeys };
    });
    if (found.secret === null) {
      throw new Problem(409, 'connection_gone', 'This connection has no stored access');
    }
    if (found.provider === 'simplefin') {
      return {
        provider: 'simplefin',
        secret: found.secret,
        institutionName: found.institutionName,
      };
    }
    const { client, credentials } = plaidClientFor(
      resolvePlaidCredentials(found.credentialSetId, this.config.plaid, found.householdKeys),
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
    return {
      provider: 'plaid',
      client,
      credentialSetId: found.credentialSetId,
      secret: found.secret,
      institutionName: found.institutionName,
    };
  }

  /** What the bank offers now, from its provider (never from what the browser said). */
  async #offered(own: OwnConnection): Promise<BankAccount[]> {
    if (own.provider === 'plaid') {
      const { accounts: got } = await own.client.accountsGet(own.secret).catch(plaidProblem);
      return got.map(fromPlaid);
    }
    const set = await new SimpleFinClient(own.secret, this.config.simplefin ?? {})
      .accounts({ balancesOnly: true })
      .catch(simpleFinProblem);
    return set.accounts.flatMap((a) => fromSimpleFin(a) ?? []);
  }

  /** The bank's accounts, each with a suggested choice for the caller (the walkthrough §3). */
  async #offer(
    tx: Executor,
    ctx: HouseholdContext,
    offered: BankAccount[],
    replaces: string | null,
  ): Promise<OfferedAccount[]> {
    const [hh] = await tx
      .select({ financeStyle: households.financeStyle, baseCurrency: households.baseCurrency })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    const levels = await accessLevels(tx);
    const ownedIds = [...levels].filter(([, level]) => level === 'owner').map(([id]) => id);
    // Only the caller's accounts (nobody connects into someone else's), and only ones no other
    // connection syncs, but the one this moves to new keys (#83).
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
          .where(
            and(
              inArray(accounts.id, ownedIds),
              replaces
                ? or(isNull(accounts.connectionId), eq(accounts.connectionId, replaces))
                : isNull(accounts.connectionId),
            ),
          )
      : [];
    const closed = new Set(candidates.filter((c) => c.closedAt).map((c) => c.id));
    const matches = matchAccounts(
      offered.map((a) => ({
        names: [a.name, a.officialName ?? ''],
        type: a.type,
        mask: a.mask,
        currency: a.currency,
      })),
      candidates.map((c) => ({ ...c, closedAt: c.closedAt?.toISOString() ?? null })),
    );
    // A bank's accounts start private to the person who connected them, whatever the household's
    // finance style: they choose who else sees each before anything syncs (D4).
    const visibility = 'private';
    return offered.map((a, i): OfferedAccount => {
      const match = matches[i];
      const suggestion: ConnectSuggestion = !match
        ? { choice: 'new', owners: [{ memberId: ctx.memberId }], visibility }
        : closed.has(match.accountId)
          ? { choice: 'skip', reason: 'closed', accountId: match.accountId }
          : { choice: 'link', accountId: match.accountId, by: match.by };
      return {
        providerAccountId: a.providerAccountId,
        name: a.name,
        officialName: a.officialName,
        type: a.type,
        subtype: a.subtype,
        mask: a.mask,
        currency: a.currency ?? hh!.baseCurrency,
        balance: a.balance,
        suggestion,
      };
    });
  }
}

/** Ends an Item at Plaid, ignoring failure: for an exchange whose connection wasn't stored. */
async function removeQuietly(client: PlaidClient, secret: string): Promise<void> {
  await client.itemRemove(secret).catch(() => undefined);
}

/**
 * A linked account's bank transactions from an earlier connection, from where the new one's sync
 * starts (D5, D6): the new connection sends them again, under ids of its own. Posted ones let go
 * of the earlier ids, so they're matched as already here (D7) instead of added twice. Pending ones
 * are dropped, as removed by the bank: it sends them again, and a pending one never matches.
 */
async function releaseEarlier(tx: Executor, accountId: string, syncFrom: string): Promise<void> {
  const earlier = and(
    eq(transactions.accountId, accountId),
    eq(transactions.source, 'provider'),
    isNotNull(transactions.providerTransactionId),
    isNull(transactions.deletedAt),
    isNull(transactions.parentId),
    sql`coalesce(${transactions.postedDate}, ${transactions.authorizedDate}) >= ${syncFrom}`,
  );
  await tx
    .update(transactions)
    .set({
      providerTransactionId: null,
      providerPendingId: null,
      version: sql`${transactions.version} + 1`,
    })
    .where(and(earlier, eq(transactions.pending, false)));
  const at = new Date();
  const dropped = await tx
    .update(transactions)
    .set({ deletedAt: at, providerRemovedAt: at, version: sql`${transactions.version} + 1` })
    .where(and(earlier, eq(transactions.pending, true)))
    .returning({ id: transactions.id });
  if (dropped.length) {
    await tx
      .update(transactions)
      .set({ deletedAt: at, version: sql`${transactions.version} + 1` })
      .where(
        and(
          inArray(
            transactions.parentId,
            dropped.map((d) => d.id),
          ),
          isNull(transactions.deletedAt),
        ),
      );
  }
}
