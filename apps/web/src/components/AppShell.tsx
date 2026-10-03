import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { clsx } from 'clsx';
import {
  Check,
  ChevronsUpDown,
  Command as CommandIcon,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  User,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { householdQuery, meQuery, membersQuery } from '../api/queries.js';
import { rememberHousehold } from '../lib/last-household.js';
import { GROUP_LABELS, phoneTabs, type Section, sectionPath, visibleSections } from '../lib/nav.js';
import { useShortcuts } from '../lib/shortcuts.js';
import { applyTheme } from '../lib/theme.js';
import { CommandPalette } from './CommandPalette.js';

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
        />
        <button
          onClick={() => setPaletteOpen(true)}
          className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface-2"
        >
          <Search aria-hidden className="size-4" /> Search
          <kbd className="ml-auto flex items-center text-xs">
            <CommandIcon aria-hidden className="size-3" />K
          </kbd>
        </button>
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
            onSignOut={actions.signOut}
            onTheme={actions.toggleTheme}
            onShortcuts={actions.showShortcuts}
          />
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone top bar */}
        <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 md:hidden">
          <span className="mr-auto truncate font-semibold">{household.name}</span>
          <button
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
            className="rounded-lg p-2 hover:bg-surface-2"
          >
            <Search aria-hidden className="size-5" />
          </button>
        </div>

        <main id="main" className="flex-1 overflow-y-auto pb-20 md:pb-0">
          <Outlet />
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
              <s.icon aria-hidden className="size-5" /> {s.label.split(' ')[0]}
            </Link>
          ))}
          <button
            onClick={() => setMoreOpen(true)}
            className="flex flex-col items-center gap-0.5 py-2 text-xs text-muted"
          >
            <Menu aria-hidden className="size-5" /> More
          </button>
        </nav>
      </div>

      {moreOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="More"
          className="fixed inset-0 z-40 md:hidden"
        >
          <button
            aria-label="Close"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMoreOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold">More</span>
              <button
                aria-label="Close"
                onClick={() => setMoreOpen(false)}
                className="rounded p-1 hover:bg-surface-2"
              >
                <X aria-hidden className="size-5" />
              </button>
            </div>
            <ul className="grid grid-cols-3 gap-2">
              {sections
                .filter((s) => !tabs.includes(s))
                .map((s) => (
                  <li key={s.id}>
                    <Link
                      to={href(s)}
                      onClick={() => setMoreOpen(false)}
                      className="flex flex-col items-center gap-1 rounded-lg p-3 text-xs hover:bg-surface-2"
                    >
                      <s.icon aria-hidden className="size-5" /> {s.label}
                    </Link>
                  </li>
                ))}
              <li>
                <Link
                  to={`/h/${householdId}/settings`}
                  onClick={() => setMoreOpen(false)}
                  className="flex flex-col items-center gap-1 rounded-lg p-3 text-xs hover:bg-surface-2"
                >
                  <Settings aria-hidden className="size-5" /> Settings
                </Link>
              </li>
              <li>
                <Link
                  to="/settings"
                  onClick={() => setMoreOpen(false)}
                  className="flex flex-col items-center gap-1 rounded-lg p-3 text-xs hover:bg-surface-2"
                >
                  <User aria-hidden className="size-5" /> You
                </Link>
              </li>
            </ul>
          </div>
        </div>
      ) : null}

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        householdId={householdId}
        sections={sections}
        sectionHref={href}
        memberships={me.memberships}
        actions={actions}
      />
      {helpOpen ? <ShortcutsHelp sections={sections} onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

function HouseholdSwitcher({
  current,
  householdId,
  memberships,
}: {
  current: string;
  householdId: string;
  memberships: { householdId: string; householdName: string; role: string }[];
}) {
  const [open, setOpen] = useState(false);
  if (memberships.length <= 1) {
    return (
      <div className="px-6 pb-3 pt-5">
        <p className="truncate text-base font-semibold">{current}</p>
      </div>
    );
  }
  return (
    <div className="relative px-3 pb-2 pt-4">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
      >
        <span className="flex-1 truncate font-semibold">{current}</span>
        <ChevronsUpDown aria-hidden className="size-4 text-muted" />
      </button>
      {open ? (
        <ul
          role="menu"
          className="absolute inset-x-3 top-full z-20 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {memberships.map((m) => (
            <li key={m.householdId} role="none">
              <Link
                role="menuitem"
                to={`/h/${m.householdId}`}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2"
              >
                <span className="flex-1 truncate">{m.householdName}</span>
                <span className="text-xs text-muted">{m.role}</span>
                {m.householdId === householdId ? <Check aria-hidden className="size-4" /> : null}
              </Link>
            </li>
          ))}
          <li role="none">
            <Link
              role="menuitem"
              to="/welcome"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-2"
            >
              <Plus aria-hidden className="size-4" /> Create household
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function UserMenu({
  name,
  onSignOut,
  onTheme,
  onShortcuts,
}: {
  name: string;
  onSignOut: () => void;
  onTheme: () => void;
  onShortcuts: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2"
      >
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex-1 truncate text-left">{name}</span>
      </button>
      {open ? (
        <ul
          role="menu"
          className="absolute inset-x-0 bottom-full z-20 mb-1 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          <li role="none">
            <Link
              role="menuitem"
              to="/settings"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2"
            >
              <User aria-hidden className="size-4" /> Personal settings
            </Link>
          </li>
          <li role="none">
            <button
              role="menuitem"
              onClick={() => (setOpen(false), onTheme())}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2"
            >
              <Moon aria-hidden className="size-4" /> Toggle dark mode
            </button>
          </li>
          <li role="none">
            <button
              role="menuitem"
              onClick={() => (setOpen(false), onShortcuts())}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2"
            >
              <span aria-hidden className="w-4 text-center">
                ?
              </span>{' '}
              Keyboard shortcuts
            </button>
          </li>
          <li role="none">
            <button
              role="menuitem"
              onClick={onSignOut}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-danger hover:bg-surface-2"
            >
              <LogOut aria-hidden className="size-4" /> Sign out
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function ShortcutsHelp({ sections, onClose }: { sections: Section[]; onClose: () => void }) {
  const rows: [string, string][] = [
    ['⌘K / Ctrl+K', 'Command palette'],
    ['?', 'This help'],
    ...sections
      .filter((s) => s.shortcut)
      .map((s): [string, string] => [`g ${s.shortcut}`, `Go to ${s.label}`]),
  ];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <button aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Keyboard shortcuts</h2>
          <button
            aria-label="Close"
            autoFocus
            onClick={onClose}
            className="rounded p-1 hover:bg-surface-2"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([keys, label]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
                  {keys}
                </kbd>
              </dt>
              <dd className="text-muted">{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
