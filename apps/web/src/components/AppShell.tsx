// SPDX-License-Identifier: AGPL-3.0-or-later
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { clsx } from 'clsx';
import {
  Check,
  ChevronsUpDown,
  Command as CommandIcon,
  LogOut,
  Keyboard,
  Menu,
  Moon,
  Plus,
  Search,
  Server,
  Settings,
  User,
  UserPlus,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { householdQuery, meQuery, membersQuery, reviewCountQuery } from '../api/queries.js';
import { rememberHousehold } from '../lib/last-household.js';
import { GROUP_LABELS, phoneTabs, type Section, sectionPath, visibleSections } from '../lib/nav.js';
import { useShortcuts } from '../lib/shortcuts.js';
import { applyTheme } from '../lib/theme.js';
import { CommandPalette } from './CommandPalette.js';
import { HistoryBanner } from './HistoryCheck.js';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Kbd,
  Menu as ActionMenu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  TimeZoneProvider,
} from './ui.js';

/** Sidebar + main area on desktop, top bar + bottom tabs on phones (IA §3). */
export function AppShell() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const me = useSuspenseQuery(meQuery).data;
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // What waits in the review queue (#44), shown on Transactions. Viewers can't review.
  const toReview =
    useQuery({ ...reviewCountQuery(householdId), enabled: household.you.role !== 'viewer' }).data
      ?.count ?? 0;
  const reviewBadge = (s: Section, className?: string) =>
    s.id === 'transactions' && toReview > 0 ? (
      <Badge tone="accent" className={className}>
        {toReview > 99 ? '99+' : toReview}
        <span className="sr-only"> to review</span>
      </Badge>
    ) : null;

  rememberHousehold(householdId);
  const sections = visibleSections(household, members.length);
  const href = (s: Section) => sectionPath(householdId, s);
  const isActive = (s: Section) =>
    s.path ? pathname.startsWith(href(s)) : pathname === href(s) || pathname === `${href(s)}/`;

  const actions = useMemo(
    () => ({
      go: (to: string) => void navigate({ to }),
      toggleTheme: () =>
        applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'),
      showShortcuts: () => setHelpOpen(true),
      signOut: async () => {
        await api('POST', '/api/v1/auth/logout').catch(() => undefined);
        queryClient.clear();
        await navigate({ to: '/login' });
      },
    }),
    [navigate, queryClient],
  );
  const shortcutHandlers = useMemo(
    () => ({
      palette: () => setPaletteOpen((o) => !o),
      help: () => setHelpOpen(true),
      jump: (key: string) => {
        const target = sections.find((s) => s.shortcut === key);
        if (target) actions.go(href(target));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, actions],
  );
  useShortcuts(shortcutHandlers);

  const groups = [...new Set(sections.map((s) => s.group))];
  const tabs = phoneTabs(household, members.length)
    .map((id) => sections.find((s) => s.id === id))
    .filter((s): s is Section => Boolean(s));

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <nav
        aria-label="Main"
        className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex"
      >
        <HouseholdSwitcher
          current={household.name}
          householdId={householdId}
          memberships={me.memberships}
          isOwner={household.you.role === 'owner'}
        />
        <Button
          variant="secondary"
          onPress={() => setPaletteOpen(true)}
          className="mx-3 mb-2 justify-start font-normal text-muted"
        >
          <Search aria-hidden className="size-4" /> Search
          <kbd aria-hidden className="ml-auto flex items-center text-xs">
            <CommandIcon className="size-3" />K
          </kbd>
        </Button>
        <div className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
          {groups.map((g) => (
            <div key={g}>
              {GROUP_LABELS[g] ? (
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                  {GROUP_LABELS[g]}
                </p>
              ) : null}
              <ul>
                {sections
                  .filter((s) => s.group === g)
                  .map((s) => (
                    <li key={s.id}>
                      <Link
                        to={href(s)}
                        aria-current={isActive(s) ? 'page' : undefined}
                        className={clsx(
                          'flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm',
                          isActive(s)
                            ? 'bg-surface-2 font-medium'
                            : 'text-muted hover:bg-surface-2 hover:text-fg',
                        )}
                      >
                        <s.icon aria-hidden className="size-4" /> {s.label}
                        {reviewBadge(s, 'ml-auto')}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-border p-3">
          <Link
            to={`/h/${householdId}/settings`}
            className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Settings aria-hidden className="size-4" /> Household settings
          </Link>
          <UserMenu
            name={me.displayName}
            color={members.find((m) => m.isYou)?.color ?? 'var(--accent)'}
            onSignOut={actions.signOut}
            onTheme={actions.toggleTheme}
            onShortcuts={actions.showShortcuts}
            isAdmin={me.isInstanceAdmin}
          />
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone top bar */}
        <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 md:hidden">
          <HouseholdSwitcher
            current={household.name}
            householdId={householdId}
            memberships={me.memberships}
            isOwner={household.you.role === 'owner'}
            compact
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search"
            onPress={() => setPaletteOpen(true)}
          >
            <Search aria-hidden className="size-5" />
          </Button>
        </div>

        {/* relative: the containing block for anything absolutely positioned inside, so it's
            clipped by this scroll area instead of making the whole page scroll. */}
        <main id="main" className="relative flex-1 overflow-y-auto pb-20 md:pb-0">
          <TimeZoneProvider timeZone={household.timezone}>
            {/* This device's check of the household's history (#264), on every page. */}
            <HistoryBanner householdId={householdId} />
            <Outlet />
          </TimeZoneProvider>
        </main>

        {/* Phone bottom tabs */}
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface md:hidden"
        >
          {tabs.map((s) => (
            <Link
              key={s.id}
              to={href(s)}
              aria-current={isActive(s) ? 'page' : undefined}
              className={clsx(
                'flex flex-col items-center gap-0.5 py-2 text-xs',
                isActive(s) ? 'text-accent' : 'text-muted',
              )}
            >
              <span className="relative">
                <s.icon aria-hidden className="size-5" />
                {reviewBadge(s, 'absolute -top-2 left-3 px-1.5 py-0 text-[10px]')}
              </span>
              {s.label.split(' ')[0]}
            </Link>
          ))}
          <Button
            variant="ghost"
            onPress={() => setMoreOpen(true)}
            className="h-auto flex-col gap-0.5 rounded-none py-2 text-xs font-normal text-muted"
          >
            <Menu aria-hidden className="size-5" /> More
          </Button>
        </nav>
      </div>

      <Dialog title="More" variant="sheet" isOpen={moreOpen} onOpenChange={setMoreOpen}>
        {(close) => (
          <ul className="grid grid-cols-3 gap-2">
            {[
              ...sections
                .filter((s) => !tabs.includes(s))
                .map((s) => ({ to: href(s), icon: s.icon, label: s.label })),
              { to: `/h/${householdId}/settings`, icon: Settings, label: 'Settings' },
              { to: '/settings', icon: User, label: 'You' },
              ...(me.isInstanceAdmin ? [{ to: '/server', icon: Server, label: 'Server' }] : []),
            ].map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  onClick={close}
                  className="flex flex-col items-center gap-1 rounded-lg p-3 text-center text-xs hover:bg-surface-2"
                >
                  <item.icon aria-hidden className="size-5" /> {item.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        householdId={householdId}
        sections={sections}
        sectionHref={href}
        memberships={me.memberships}
        isAdmin={me.isInstanceAdmin}
        actions={actions}
      />
      <ShortcutsHelp sections={sections} isOpen={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/**
 * The household's name, as a menu: other households to switch to, inviting someone (owners), the
 * household's settings, and creating another household. On phones it's in the top bar.
 */
function HouseholdSwitcher({
  current,
  householdId,
  memberships,
  isOwner,
  compact,
}: {
  current: string;
  householdId: string;
  memberships: { householdId: string; householdName: string; role: string }[];
  isOwner: boolean;
  /** The phone top bar: no padding of its own. */
  compact?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div className={compact ? 'flex min-w-0 flex-1' : 'px-3 pb-2 pt-4'}>
      <MenuTrigger>
        <Button
          variant="ghost"
          className={clsx('justify-start text-left', compact ? '-ml-2.5 max-w-full' : 'w-full')}
        >
          <span className={clsx('truncate text-base font-semibold', !compact && 'flex-1')}>
            {current}
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted" />
        </Button>
        <ActionMenu placement="bottom start" aria-label="Household">
          {memberships.length > 1 ? (
            <>
              {memberships.map((m) => (
                <MenuItem
                  key={m.householdId}
                  href={`/h/${m.householdId}`}
                  textValue={m.householdName}
                >
                  <span className="flex-1 truncate">{m.householdName}</span>
                  <span className="text-xs text-muted capitalize">{m.role}</span>
                  {m.householdId === householdId ? (
                    <Check aria-label="Current household" className="text-accent-text" />
                  ) : null}
                </MenuItem>
              ))}
              <MenuSeparator />
            </>
          ) : null}
          {isOwner ? (
            <MenuItem
              onAction={() =>
                void navigate({
                  to: '/h/$householdId/settings/members',
                  params: { householdId },
                  search: { invite: '1' },
                })
              }
            >
              <UserPlus aria-hidden /> Invite someone
            </MenuItem>
          ) : null}
          {/* The sidebar links to it on a computer; a phone has no sidebar. */}
          {compact ? (
            <MenuItem href={`/h/${householdId}/settings`}>
              <Settings aria-hidden /> Household settings
            </MenuItem>
          ) : null}
          <MenuItem href="/welcome">
            <Plus aria-hidden /> Create household
          </MenuItem>
        </ActionMenu>
      </MenuTrigger>
    </div>
  );
}

function UserMenu({
  name,
  color,
  onSignOut,
  onTheme,
  onShortcuts,
  isAdmin,
}: {
  name: string;
  color: string;
  /** Instance admins also manage the server. */
  isAdmin: boolean;
  onSignOut: () => void;
  onTheme: () => void;
  onShortcuts: () => void;
}) {
  return (
    <MenuTrigger>
      <Button variant="ghost" className="mt-1 w-full justify-start font-normal">
        <Avatar name={name} color={color} size="sm" />
        <span className="flex-1 truncate text-left">{name}</span>
      </Button>
      <ActionMenu placement="top start" aria-label="Account">
        <MenuItem href="/settings">
          <User aria-hidden /> Personal settings
        </MenuItem>
        {isAdmin ? (
          <MenuItem href="/server">
            <Server aria-hidden /> Server
          </MenuItem>
        ) : null}
        <MenuItem onAction={onTheme}>
          <Moon aria-hidden /> Toggle dark mode
        </MenuItem>
        <MenuItem onAction={onShortcuts}>
          <Keyboard aria-hidden /> Keyboard shortcuts
        </MenuItem>
        <MenuSeparator />
        <MenuItem onAction={onSignOut} tone="danger">
          <LogOut aria-hidden /> Sign out
        </MenuItem>
      </ActionMenu>
    </MenuTrigger>
  );
}

function ShortcutsHelp({
  sections,
  isOpen,
  onOpenChange,
}: {
  sections: Section[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rows: [string, string][] = [
    ['⌘K / Ctrl+K', 'Command palette'],
    ['?', 'This help'],
    ...sections
      .filter((s) => s.shortcut)
      .map((s): [string, string] => [`g ${s.shortcut}`, `Go to ${s.label}`]),
  ];
  return (
    <Dialog title="Keyboard shortcuts" size="sm" isOpen={isOpen} onOpenChange={onOpenChange}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([keys, label]) => (
          <div key={keys} className="contents">
            <dt>
              <Kbd>{keys}</Kbd>
            </dt>
            <dd className="text-muted">{label}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
