// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AccountChoiceInput,
  AccountVisibility,
  BankAlreadyConnected,
  ConnectionConfirmed,
  ConnectionSetup,
  Household,
  HouseholdMember,
  OfferedAccount,
  PlaidLinkToken,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ChevronRight, Lock, ShieldCheck, UsersRound } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  type PlaidLinkOnExit,
  type PlaidLinkOnSuccess,
  type PlaidLinkOnSuccessMetadata,
  usePlaidLink,
} from 'react-plaid-link';
import { api, type ApiError } from '../api/client.js';
import {
  accountsQuery,
  connectionSetupQuery,
  householdQuery,
  membersQuery,
  plaidAvailabilityQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import {
  Alert,
  Badge,
  Button,
  buttonStyles,
  ConfirmDialog,
  DateText,
  LoadingRegion,
  Select,
  SelectItem,
  SelectSection,
  Skeleton,
  TimeZoneProvider,
} from '../components/ui.js';
import { balanceKind, DEFAULT_VISIBILITY, privateAllowed, VISIBILITY } from '../lib/accounts.js';
import { leaveTo } from '../lib/flash.js';
import {
  clearOAuthState,
  linkExit,
  linkMetadata,
  readOAuthState,
  saveOAuthState,
} from '../lib/plaid-link.js';

// Connecting a bank through Plaid Link (#79, the bank connections walkthrough §2–§4). Its own
// pages, outside the app's shell: the only ones whose Content-Security-Policy allows Plaid's script
// (nginx.conf, threat model T4). It's entered and left with full page loads, never the router,
// so Plaid's script and the wider policy never carry over to another page. Hence no sidebar or
// tabs here: every way out is a plain link.

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;
const accountsUrl = (householdId: string) => `/h/${householdId}/accounts`;

/** The page's frame: the household's name, and one card (a sheet of its own on a phone). */
function ConnectLayout({
  household,
  wide,
  children,
}: {
  household: Household;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <TimeZoneProvider timeZone={household.timezone}>
      <div className="min-h-full bg-bg">
        <header className="border-b border-border bg-surface px-4 py-3 md:px-8">
          <p className="font-semibold">{household.name}</p>
        </header>
        <main
          id="main"
          className={clsx('mx-auto w-full px-4 py-6 md:py-12', wide ? 'max-w-4xl' : 'max-w-2xl')}
        >
          <div className="space-y-5 md:rounded-xl md:border md:border-border md:bg-surface md:p-6 md:shadow-md">
            {children}
          </div>
        </main>
      </div>
    </TimeZoneProvider>
  );
}

/** The step's title, focused when it appears so screen readers announce the step. */
function Heading({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="space-y-1">
      <h1 ref={ref} tabIndex={-1} className="text-xl font-semibold outline-none">
        {children}
      </h1>
      {sub ? <p className="text-sm text-muted">{sub}</p> : null}
    </div>
  );
}

/** A way out: a plain link, so it's a full page load. */
function LeaveLink({
  href,
  variant = 'secondary',
  children,
}: {
  href: string;
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}) {
  return (
    <a href={href} className={buttonStyles({ variant })}>
      {children}
    </a>
  );
}

const STEPS = [
  { label: 'Sign in', short: 'Sign in' },
  { label: 'Choose accounts', short: 'Accounts' },
  { label: 'First sync', short: 'Sync' },
];

function Steps({ current }: { current: number }) {
  return (
    <ol aria-label="Connecting a bank" className="flex items-center gap-1.5 text-sm text-muted">
      {STEPS.map((s, i) => (
        <li
          key={s.label}
          aria-current={i === current ? 'step' : undefined}
          className={clsx('flex items-center gap-1.5', i === current && 'font-medium text-fg')}
        >
          {i > 0 ? <ChevronRight aria-hidden className="size-3.5" /> : null}
          <span className="md:hidden">{s.short}</span>
          <span className="hidden md:inline">{s.label}</span>
          {i < current ? <span className="sr-only"> (done)</span> : null}
        </li>
      ))}
    </ol>
  );
}

function ViewerNotice({ household }: { household: Household }) {
  return (
    <ConnectLayout household={household}>
      <Heading>Connect a bank</Heading>
      <p className="text-sm text-muted">
        Viewers can’t connect banks. Ask an owner or a member of {household.name} to connect it.
      </p>
      <div className="flex justify-end">
        <LeaveLink href={accountsUrl(household.id)}>Back to accounts</LeaveLink>
      </div>
    </ConnectLayout>
  );
}

// ── Before Link opens, and Link ────────────────────────────────────────────────────────────────

/**
 * `/h/:id/connect/plaid`: what connecting means, then Plaid Link. With `?connection=`, Link's
 * update mode, for its owner to sign in again (the button that leads here is #81's).
 */
export function ConnectPlaidPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const { connection } = useSearch({ strict: false }) as { connection?: string };
  return <ConnectFlow householdId={householdId} connection={connection} />;
}

/**
 * `/connect/plaid/oauth`: back from a bank's own sign-in page (OAuth). Link picks up where it
 * left off, with the link token kept when it opened, and opens at once.
 */
export function PlaidOAuthReturnPage() {
  const [state] = useState(() => readOAuthState());
  if (!state) {
    return (
      <div className="min-h-full bg-bg">
        <main id="main" className="mx-auto w-full max-w-2xl px-4 py-6 md:py-12">
          <div className="space-y-5 md:rounded-xl md:border md:border-border md:bg-surface md:p-6 md:shadow-md">
            <Heading>This bank sign-in can’t continue</Heading>
            <p className="text-sm text-muted">
              It started too long ago, or in another browser. Connect the bank again from its
              household’s accounts.
            </p>
            <div className="flex justify-end">
              <LeaveLink href="/" variant="primary">
                Go to Fiscus
              </LeaveLink>
            </div>
          </div>
        </main>
      </div>
    );
  }
  return (
    <ConnectFlow
      householdId={state.householdId}
      connection={state.connection}
      resume={{ linkToken: state.linkToken, receivedRedirectUri: window.location.href }}
    />
  );
}

/** A Link session that was connected, waiting while you decide about a duplicate. */
interface Duplicate {
  found: BankAlreadyConnected;
  bank: string | null;
  publicToken: string;
  metadata: PlaidLinkOnSuccessMetadata;
}

function ConnectFlow({
  householdId,
  connection,
  resume,
}: {
  householdId: string;
  connection?: string | undefined;
  resume?: { linkToken: string; receivedRedirectUri: string };
}) {
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const viewer = household.you.role === 'viewer';
  const availability = useQuery({
    ...plaidAvailabilityQuery(householdId),
    enabled: !viewer && !connection && !resume,
  });
  // The link token as the page loads, so Link is ready the moment you continue. One per visit,
  // and a fresh one after Link stops (a token is for one session).
  const token = useQuery({
    queryKey: ['plaid-link-token', householdId, connection ?? null],
    queryFn: async () => {
      const query = connection ? `?connection=${encodeURIComponent(connection)}` : '';
      return (
        await api<Data<PlaidLinkToken>>('POST', `${base(householdId)}/plaid/link-token${query}`)
      ).data.linkToken;
    },
    enabled: !viewer && !resume && (!!connection || availability.data?.available === true),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const linkToken = resume?.linkToken ?? token.data ?? null;
  const [phase, setPhase] = useState<'explain' | 'open' | 'exchanging'>(
    resume ? 'open' : 'explain',
  );
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const back = accountsUrl(householdId);

  const exchange = async (
    publicToken: string,
    metadata: PlaidLinkOnSuccessMetadata,
    duplicateOk = false,
  ) => {
    setPhase('exchanging');
    setDuplicate(null);
    try {
      const setup = (
        await api<Data<ConnectionSetup>>('POST', `${base(householdId)}/plaid/exchange`, {
          body: { publicToken, link: linkMetadata(metadata), ...(duplicateOk && { duplicateOk }) },
        })
      ).data;
      queryClient.setQueryData(
        connectionSetupQuery(householdId, setup.connectionId).queryKey,
        setup,
      );
      // Still a connect page (the same policy, the same document): a reload offers it again.
      await navigate({
        to: '/h/$householdId/connect/plaid/$connectionId',
        params: { householdId, connectionId: setup.connectionId },
        replace: true,
      });
    } catch (err) {
      const e = err as ApiError;
      setPhase('explain');
      if (e.code === 'bank_already_connected') {
        setDuplicate({
          found: e.body as unknown as BankAlreadyConnected,
          bank: metadata.institution?.name ?? null,
          publicToken,
          metadata,
        });
      } else {
        setError(e.detail ?? e.message);
      }
    }
  };

  // Link's callbacks, kept stable: react-plaid-link starts Link again whenever they change.
  const callbacks = useRef<{ onSuccess: PlaidLinkOnSuccess; onExit: PlaidLinkOnExit }>(null!);
  useLayoutEffect(() => {
    callbacks.current = {
      onSuccess: (publicToken, metadata) => {
        clearOAuthState();
        // Update mode keeps the same connection: there's nothing to exchange.
        if (connection) leaveTo(back, { title: 'Signed in to your bank again.', tone: 'success' });
        else if (publicToken) void exchange(publicToken, metadata);
      },
      onExit: (err, metadata) => {
        clearOAuthState();
        // For Plaid's support, should it come to that: the session and Plaid's codes.
        const exit = linkExit(err, metadata);
        if (exit) {
          void api('POST', `${base(householdId)}/plaid/link-exit`, { body: exit }).catch(
            () => undefined,
          );
        }
        const message = err
          ? (err.display_message ?? 'Plaid stopped with an error. Try again in a few minutes.')
          : null;
        if (resume) {
          // The OAuth return's token is spent: back to Accounts, which says how it went.
          leaveTo(
            back,
            message
              ? { title: 'The bank wasn’t connected', description: message, tone: 'error' }
              : undefined,
          );
          return;
        }
        // Closing Link isn't an error: you're back where you were, ready to try again.
        setPhase('explain');
        setError(message);
        void token.refetch();
      },
    };
  });
  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (t, m) => callbacks.current.onSuccess(t, m),
    [],
  );
  const onExit = useCallback<PlaidLinkOnExit>((e, m) => callbacks.current.onExit(e, m), []);
  const link = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit,
    ...(resume && { receivedRedirectUri: resume.receivedRedirectUri }),
  });

  // Back from the bank: Link resumes at once, without waiting for a press.
  const resumed = useRef(false);
  useEffect(() => {
    if (resume && link.ready && !resumed.current) {
      resumed.current = true;
      link.open();
    }
  }, [resume, link]);

  const open = () => {
    if (!linkToken) return;
    setError(null);
    setPhase('open');
    // A bank's own sign-in page (OAuth) may send this tab away: its return picks Link up again.
    saveOAuthState({ linkToken, householdId, ...(connection && { connection }) });
    link.open();
  };

  if (viewer) return <ViewerNotice household={household} />;

  if (phase === 'exchanging' || (resume && phase === 'open')) {
    return (
      <ConnectLayout household={household}>
        <Steps current={0} />
        <LoadingRegion
          label={phase === 'exchanging' ? 'Getting your accounts from the bank' : 'Opening Plaid'}
        >
          <Heading
            sub={
              phase === 'exchanging'
                ? 'Getting your accounts from the bank…'
                : 'Back from your bank. Plaid opens again to finish…'
            }
          >
            {phase === 'exchanging' ? 'Signed in' : 'Connecting your bank'}
          </Heading>
          <div className="mt-4 space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </LoadingRegion>
      </ConnectLayout>
    );
  }

  if (duplicate)
    return (
      <AlreadyConnected
        household={household}
        duplicate={duplicate}
        onConnectAnyway={() => void exchange(duplicate.publicToken, duplicate.metadata, true)}
      />
    );

  const unavailable =
    availability.data && !availability.data.available ? availability.data.reason : null;
  const tokenError = token.error as ApiError | null;
  const shownError =
    error ??
    (link.error
      ? 'Plaid couldn’t be loaded. Check your connection, then reload the page.'
      : tokenError && tokenError.code !== 'plaid_unavailable'
        ? (tokenError.detail ?? tokenError.message)
        : null);
  return (
    <ConnectLayout household={household}>
      {connection ? (
        <Heading sub="Plaid opens next. Sign in to your bank there, not here; Fiscus never sees your bank password.">
          Sign in to your bank again
        </Heading>
      ) : (
        <Heading sub="Plaid opens next and connects it instantly. You sign in to your bank there, not here; Fiscus never sees your bank password.">
          Add a bank account
        </Heading>
      )}
      {shownError ? <Alert>{shownError}</Alert> : null}
      {unavailable ? (
        <Alert tone="info">
          {unavailable === 'not_configured'
            ? 'This server has no Plaid keys, so banks can’t be connected through Plaid. Its admin can add them.'
            : 'This household uses its own Plaid keys, which this server can’t use yet.'}
        </Alert>
      ) : null}
      {!connection ? (
        <dl className="space-y-4 rounded-lg bg-surface-2 p-4 text-sm">
          <Point icon={ShieldCheck} title="What Fiscus gets">
            Read-only access to the accounts you choose: balances, transactions, and card and loan
            details, refreshed several times a day. It can’t move money, and you can disconnect it
            any time.
          </Point>
          <Point icon={UsersRound} title="Whose they are">
            Accounts you connect are yours to start with. Next you choose which ones to track, link
            them to accounts you already have here, and decide who else in the household sees them.
            Nothing syncs until you do.
          </Point>
          <Point icon={Lock} title="Where it’s stored">
            The connection is encrypted with this household’s key, on this server.
          </Point>
        </dl>
      ) : null}
      {availability.data?.available ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          Through this server’s Plaid account.
          {availability.data.env === 'sandbox' ? (
            <Badge tone="warning">Sandbox: Plaid’s test banks only</Badge>
          ) : null}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <LeaveLink href={back}>Cancel</LeaveLink>
        <Button
          onPress={open}
          isPending={phase === 'open' || (!unavailable && !shownError && !link.ready)}
          isDisabled={!!unavailable || !link.ready}
        >
          Continue to Plaid
        </Button>
      </div>
    </ConnectLayout>
  );
}

/** You've connected these accounts at this bank already: use that connection, or go ahead. */
function AlreadyConnected({
  household,
  duplicate: { found, bank },
  onConnectAnyway,
}: {
  household: Household;
  duplicate: Duplicate;
  onConnectAnyway: () => void;
}) {
  const name = bank ?? 'this bank';
  const there = `/h/${household.id}/connect/plaid`;
  const back = accountsUrl(household.id);
  const [sub, action] =
    found.status === 'setup'
      ? [
          `You started connecting ${name} already, and haven’t chosen its accounts yet.`,
          { href: `${there}/${found.connectionId}`, label: 'Choose its accounts' },
        ]
      : found.status === 'login_required'
        ? [
            `These accounts at ${name} already have a connection, which needs you to sign in again. Signing in there keeps its history.`,
            {
              href: `${there}?connection=${encodeURIComponent(found.connectionId)}`,
              label: 'Sign in again there',
            },
          ]
        : [
            `These accounts at ${name} already sync through your connection. A second one would show them twice.`,
            null,
          ];
  return (
    <ConnectLayout household={household}>
      <Heading sub={sub}>You’ve connected {name} already</Heading>
      <p className="text-sm text-muted">
        If it’s a different login at the same bank, with other accounts, connect it anyway.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        {action ? <LeaveLink href={back}>Cancel</LeaveLink> : null}
        <Button variant="secondary" onPress={onConnectAnyway}>
          Connect it anyway
        </Button>
        <LeaveLink href={action?.href ?? back} variant="primary">
          {action?.label ?? 'Go to accounts'}
        </LeaveLink>
      </div>
    </ConnectLayout>
  );
}

function Point({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Lock;
  title: string;
  children: ReactNode;
}) {
  // One group per point, holding only its term and its description (as a <dl> must).
  return (
    <div>
      <dt className="flex items-center gap-3 font-medium">
        <Icon aria-hidden className="size-4 shrink-0 text-accent-text" />
        {title}
      </dt>
      <dd className="pl-7 text-muted">{children}</dd>
    </div>
  );
}

// ── Choosing accounts ──────────────────────────────────────────────────────────────────────────

/** What one offered account becomes, as the page holds it. */
interface Choice {
  providerAccountId: string;
  choice: 'link' | 'new' | 'skip';
  accountId: string | null;
  owners: string[];
  visibility: AccountVisibility;
}

const fromSuggestion = (a: OfferedAccount, defaults: Choice): Choice => {
  const s = a.suggestion;
  if (s.choice === 'link') return { ...defaults, choice: 'link', accountId: s.accountId };
  if (s.choice === 'skip') return { ...defaults, choice: 'skip' };
  return {
    ...defaults,
    choice: 'new',
    owners: s.owners.map((o) => o.memberId),
    visibility: s.visibility,
  };
};

/** A joint account can't stay private in a two-person household (F2): it's shared instead. */
const shownVisibility = (c: Choice, activeMembers: number): AccountVisibility =>
  c.visibility === 'private' && !privateAllowed(c.owners.length, activeMembers)
    ? 'full'
    : c.visibility;

/** The body for `…/confirm`. */
export function confirmBody(choices: Choice[], activeMembers: number): AccountChoiceInput[] {
  return choices.map((c): AccountChoiceInput => {
    if (c.choice === 'link')
      return { providerAccountId: c.providerAccountId, choice: 'link', accountId: c.accountId! };
    if (c.choice === 'skip') return { providerAccountId: c.providerAccountId, choice: 'skip' };
    return {
      providerAccountId: c.providerAccountId,
      choice: 'new',
      owners: c.owners.map((memberId) => ({ memberId })),
      visibility: shownVisibility(c, activeMembers),
    };
  });
}

const capitalized = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/**
 * `/h/:id/connect/plaid/:connectionId`: one choice per account the bank offers (§3, D4, D5),
 * then the first sync. A reload asks the api for the offer again (`…/setup`).
 */
export function ConnectSetupPage() {
  const { householdId, connectionId } = useParams({ strict: false }) as {
    householdId: string;
    connectionId: string;
  };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const setup = useQuery({
    ...connectionSetupQuery(householdId, connectionId),
    enabled: household.you.role !== 'viewer',
  });
  const [confirmed, setConfirmed] = useState<ConnectionConfirmed | null>(null);
  const [chosen, setChosen] = useState<Choice[]>([]);

  if (household.you.role === 'viewer') return <ViewerNotice household={household} />;
  if (confirmed && setup.data) {
    return (
      <Connected household={household} setup={setup.data} confirmed={confirmed} choices={chosen} />
    );
  }
  if (setup.isPending) {
    return (
      <ConnectLayout household={household} wide>
        <Steps current={1} />
        <LoadingRegion label="Getting your accounts from the bank">
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        </LoadingRegion>
      </ConnectLayout>
    );
  }
  if (setup.isError) {
    const err = setup.error as ApiError;
    return (
      <ConnectLayout household={household}>
        <Heading>
          {err.code === 'not_in_setup' ? 'This bank is already connected' : 'Couldn’t continue'}
        </Heading>
        <p className="text-sm text-muted">
          {err.code === 'not_in_setup'
            ? 'Its accounts were chosen already, and they sync on their own.'
            : (err.detail ?? err.title)}
        </p>
        <div className="flex justify-end">
          <LeaveLink href={accountsUrl(householdId)} variant="primary">
            Go to accounts
          </LeaveLink>
        </div>
      </ConnectLayout>
    );
  }
  return (
    <ChooseAccounts
      household={household}
      setup={setup.data}
      onConfirmed={(result, choices) => {
        setChosen(choices);
        setConfirmed(result);
      }}
    />
  );
}

function ChooseAccounts({
  household,
  setup,
  onConfirmed,
}: {
  household: Household;
  setup: ConnectionSetup;
  onConfirmed: (result: ConnectionConfirmed, choices: Choice[]) => void;
}) {
  const me = household.you.memberId;
  const members = useQuery(membersQuery(household.id)).data ?? [];
  // Yours, open or closed, to link to: only your own can be linked (ACC-01).
  const yours = (useQuery(accountsQuery(household.id, 'all', 'closed')).data ?? []).filter((a) =>
    a.owners.some((o) => o.memberId === me),
  );
  const defaults: Choice = {
    providerAccountId: '',
    choice: 'new',
    accountId: null,
    owners: [me],
    visibility: DEFAULT_VISIBILITY[household.financeStyle],
  };
  const [choices, setChoices] = useState<Choice[]>(() =>
    setup.accounts.map((a) =>
      fromSuggestion(a, { ...defaults, providerAccountId: a.providerAccountId }),
    ),
  );
  const [cancelling, setCancelling] = useState(false);
  const update = (id: string, patch: Partial<Choice>) =>
    setChoices((all) => all.map((c) => (c.providerAccountId === id ? { ...c, ...patch } : c)));
  const tracked = choices.filter((c) => c.choice !== 'skip').length;
  const bank = setup.institutionName ?? 'Your bank';
  const back = accountsUrl(household.id);

  const confirm = useMutation({
    mutationFn: () =>
      api<Data<ConnectionConfirmed>>(
        'POST',
        `${base(household.id)}/connections/${setup.connectionId}/confirm`,
        { body: { accounts: confirmBody(choices, members.length) } },
      ),
    onSuccess: (r) => onConfirmed(r.data, choices),
  });
  const err = confirm.error as ApiError | null;

  return (
    <ConnectLayout household={household} wide>
      <Steps current={1} />
      <Heading sub="Link an account to one you already have here to keep its history. New ones start with the last 90 days. Nothing syncs until you choose.">
        {setup.institutionName ? `${bank}: choose what to track` : 'Choose what to track'}
      </Heading>
      {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
      <ul
        aria-label="Accounts at the bank"
        className="divide-y divide-border rounded-xl border border-border bg-surface"
      >
        {setup.accounts.map((a) => (
          <OfferedRow
            key={a.providerAccountId}
            account={a}
            choice={choices.find((c) => c.providerAccountId === a.providerAccountId)!}
            choices={choices}
            yours={yours}
            members={members}
            me={me}
            onChange={(patch) => update(a.providerAccountId, patch)}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {tracked === 0 ? (
          <p className="mr-auto text-sm text-muted" role="status">
            Choose at least one account to track.
          </p>
        ) : null}
        <Button variant="secondary" onPress={() => setCancelling(true)}>
          Cancel
        </Button>
        <Button
          className="max-md:w-full"
          onPress={() => confirm.mutate()}
          isPending={confirm.isPending}
          isDisabled={tracked === 0}
        >
          Track {tracked} {tracked === 1 ? 'account' : 'accounts'}
        </Button>
      </div>
      <ConfirmDialog
        title={`Don’t connect ${bank}?`}
        isOpen={cancelling}
        onOpenChange={setCancelling}
        confirmLabel="Don’t connect"
        cancelLabel="Keep choosing"
        destructive
        onConfirm={async () => {
          await api('DELETE', `${base(household.id)}/connections/${setup.connectionId}`);
          leaveTo(back, { title: `${bank} wasn’t connected.`, tone: 'info' });
        }}
      >
        Fiscus lets go of its access to {bank}, and nothing is tracked. You can connect it again any
        time.
      </ConfirmDialog>
    </ConnectLayout>
  );
}

/** Owners to choose from: you alone, you and one other, or everyone who can own accounts. */
function ownerOptions(members: HouseholdMember[], me: string) {
  const others = members.filter((m) => m.role !== 'viewer' && m.id !== me);
  const options = [
    { id: 'me', label: 'You', owners: [me] },
    ...others.map((m) => ({
      id: `me+${m.id}`,
      label: `You & ${m.displayName}`,
      owners: [me, m.id],
    })),
  ];
  if (others.length > 1) {
    options.push({ id: 'all', label: 'Everyone', owners: [me, ...others.map((m) => m.id)] });
  }
  return options;
}

const sameOwners = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

function OfferedRow({
  account: a,
  choice: c,
  choices,
  yours,
  members,
  me,
  onChange,
}: {
  account: OfferedAccount;
  choice: Choice;
  choices: Choice[];
  yours: Account[];
  members: HouseholdMember[];
  me: string;
  onChange: (patch: Partial<Choice>) => void;
}) {
  const s = a.suggestion;
  const taken = new Set(
    choices
      .filter((o) => o.providerAccountId !== c.providerAccountId && o.choice === 'link')
      .map((o) => o.accountId),
  );
  // Linking needs the same currency (the api refuses others).
  const targets = yours.filter((y) => y.currency === a.currency && !taken.has(y.id));
  const linked = yours.find((y) => y.id === c.accountId);
  const owners = ownerOptions(members, me);
  const ownersId = owners.find((o) => sameOwners(o.owners, c.owners))?.id ?? 'me';
  const allowPrivate = privateAllowed(c.owners.length, members.length);
  const visibility = shownVisibility(c, members.length);
  const kind = [
    a.subtype ? capitalized(a.subtype) : null,
    a.officialName && a.officialName !== a.name ? a.officialName : null,
  ]
    .filter(Boolean)
    .join(' · ');

  let reason: string | null = null;
  if (c.choice === 'link' && s.choice === 'link' && s.accountId === c.accountId) {
    reason = `${s.by === 'mask' ? 'Same last 4 digits and type' : 'Same name'}. Keeps its history; sync fills in after it.`;
  } else if (c.choice === 'link') {
    reason = 'Keeps its history; sync fills in after it.';
  } else if (c.choice === 'skip' && s.choice === 'skip') {
    const closed = yours.find((y) => y.id === s.accountId);
    reason = `Matches ${closed?.name ?? 'an account'} you closed here, so it isn’t tracked.`;
  }

  return (
    <li className="grid gap-3 p-4 md:grid-cols-[1fr_18rem] md:items-start">
      <div className="flex min-w-0 gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft font-semibold text-accent-text"
        >
          {[...a.name][0]?.toLocaleUpperCase() ?? '?'}
        </span>
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium">
            {a.name}
            {a.mask ? (
              <span className="font-normal text-muted">
                {' '}
                <span aria-hidden>••</span>
                <span className="sr-only">ending in </span>
                {a.mask}
              </span>
            ) : null}
          </p>
          <p className="text-muted">
            {kind ? `${kind} · ` : null}
            {a.balance ? (
              <>
                balance{' '}
                <Amount
                  minor={a.balance.amountMinor}
                  currency={a.balance.currency}
                  kind={balanceKind(a.type)}
                />
              </>
            ) : (
              'no balance yet'
            )}
          </p>
          {c.choice === 'new' && members.length > 1 ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
              {owners.length > 1 ? (
                <Select
                  label="Owners"
                  appearance="chip"
                  className="items-center gap-1.5 [&>label]:text-xs [&>label]:font-normal [&>label]:text-muted"
                  value={ownersId}
                  onChange={(v) => {
                    const o = owners.find((x) => x.id === v);
                    if (o) onChange({ owners: o.owners });
                  }}
                >
                  {owners.map((o) => (
                    <SelectItem key={o.id} id={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </Select>
              ) : null}
              <Select
                label="Who sees it"
                appearance="chip"
                className="items-center gap-1.5 [&>label]:text-xs [&>label]:font-normal [&>label]:text-muted"
                value={visibility}
                disabledKeys={allowPrivate ? [] : ['private']}
                onChange={(v) => v && onChange({ visibility: v as AccountVisibility })}
              >
                {(Object.keys(VISIBILITY) as AccountVisibility[]).map((v) => (
                  <SelectItem key={v} id={v}>
                    {VISIBILITY[v].label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
      </div>
      <div className="space-y-1">
        <Select
          aria-label={`What ${a.name}${a.mask ? ` ending in ${a.mask}` : ''} becomes`}
          value={c.choice === 'link' ? c.accountId : c.choice}
          onChange={(v) => {
            const value = String(v);
            if (value === 'new' || value === 'skip') onChange({ choice: value, accountId: null });
            else onChange({ choice: 'link', accountId: value });
          }}
        >
          <SelectItem id="new">New account</SelectItem>
          <SelectItem id="skip">Don’t track</SelectItem>
          {targets.length || linked ? (
            <SelectSection title="Link to one of yours">
              {[...(linked && !targets.includes(linked) ? [linked] : []), ...targets].map((y) => (
                <SelectItem key={y.id} id={y.id} textValue={`Link to ${y.name}`}>
                  Link to {y.name}
                  {y.closedAt ? ' (closed)' : ''}
                </SelectItem>
              ))}
            </SelectSection>
          ) : null}
        </Select>
        {reason ? <p className="text-xs text-muted">{reason}</p> : null}
      </div>
    </li>
  );
}

// ── Connected: the first sync is running ───────────────────────────────────────────────────────

function Connected({
  household,
  setup,
  confirmed,
  choices,
}: {
  household: Household;
  setup: ConnectionSetup;
  confirmed: ConnectionConfirmed;
  choices: Choice[];
}) {
  const members = useQuery(membersQuery(household.id)).data ?? [];
  const yours = useQuery(accountsQuery(household.id, 'all', 'closed')).data ?? [];
  const bank = setup.institutionName ?? 'Your bank';
  const name = (id: string) => members.find((m) => m.id === id);
  return (
    <ConnectLayout household={household}>
      <Steps current={2} />
      <Heading sub="The first sync is running. Recent transactions arrive in a minute or so; older history keeps arriving for a few minutes, and is added as it comes. Nothing waits on it.">
        {bank} is connected
      </Heading>
      <ul
        aria-label="Tracked accounts"
        className="divide-y divide-border rounded-xl border border-border bg-surface text-sm"
      >
        {confirmed.accounts.map((t) => {
          const offered = setup.accounts.find((a) => a.providerAccountId === t.providerAccountId);
          const choice = choices.find((c) => c.providerAccountId === t.providerAccountId);
          const account = yours.find((y) => y.id === t.accountId);
          const detail = t.linked
            ? 'Linked · its history stays'
            : [
                'New',
                choice?.owners
                  .map((id) => (name(id)?.isYou ? 'you' : name(id)?.displayName))
                  .filter(Boolean)
                  .join(' & '),
                choice && members.length > 1
                  ? VISIBILITY[shownVisibility(choice, members.length)].label.toLowerCase()
                  : null,
              ]
                .filter(Boolean)
                .join(' · ');
          return (
            <li
              key={t.providerAccountId}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-4"
            >
              <div>
                <p className="font-medium">{account?.name ?? offered?.name ?? 'Account'}</p>
                <p className="text-muted">{detail}</p>
              </div>
              <p className="text-muted">
                Syncing from <DateText value={t.syncFrom} />
              </p>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <LeaveLink href={accountsUrl(household.id)} variant="primary">
          Go to accounts
        </LeaveLink>
      </div>
    </ConnectLayout>
  );
}
