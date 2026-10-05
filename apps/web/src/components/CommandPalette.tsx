// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Membership } from '@fiscus/shared';
import { Command } from 'cmdk';
import { Home, LogOut, Moon, Settings, Sun, User } from 'lucide-react';
import type { Section } from '../lib/nav.js';

export interface PaletteActions {
  go: (path: string) => void;
  toggleTheme: () => void;
  signOut: () => void;
  showShortcuts: () => void;
}

/** ⌘K / Ctrl+K: jump anywhere, switch household, run actions (IA §3). */
export function CommandPalette({
  open,
  onOpenChange,
  householdId,
  sections,
  sectionHref,
  memberships,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  householdId: string;
  sections: Section[];
  sectionHref: (s: Section) => string;
  memberships: Membership[];
  actions: PaletteActions;
}) {
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  const item =
    'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm aria-selected:bg-surface-2';
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-x-4 top-[15vh] z-50 mx-auto max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      overlayClassName="fixed inset-0 z-40 bg-black/40"
    >
      <Command.Input
        placeholder="Go to, switch household, or run a command…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
          No matches.
        </Command.Empty>
        <Command.Group
          heading="Go to"
          className="text-xs text-muted [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1"
        >
          {sections.map((s) => (
            <Command.Item
              key={s.id}
              value={`go ${s.label}`}
              onSelect={run(() => actions.go(sectionHref(s)))}
              className={item}
            >
              <s.icon aria-hidden className="size-4 text-muted" /> {s.label}
            </Command.Item>
          ))}
          <Command.Item
            value="go household settings"
            onSelect={run(() => actions.go(`/h/${householdId}/settings`))}
            className={item}
          >
            <Settings aria-hidden className="size-4 text-muted" /> Household settings
          </Command.Item>
          <Command.Item
            value="go personal settings sessions profile"
            onSelect={run(() => actions.go('/settings'))}
            className={item}
          >
            <User aria-hidden className="size-4 text-muted" /> Personal settings
          </Command.Item>
        </Command.Group>
        {memberships.length > 1 ? (
          <Command.Group
            heading="Switch household"
            className="text-xs text-muted [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1"
          >
            {memberships
              .filter((m) => m.householdId !== householdId)
              .map((m) => (
                <Command.Item
                  key={m.householdId}
                  value={`switch ${m.householdName}`}
                  onSelect={run(() => actions.go(`/h/${m.householdId}`))}
                  className={item}
                >
                  <Home aria-hidden className="size-4 text-muted" /> {m.householdName}
                </Command.Item>
              ))}
          </Command.Group>
        ) : null}
        <Command.Group
          heading="Actions"
          className="text-xs text-muted [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1"
        >
          <Command.Item
            value="toggle theme dark light mode"
            onSelect={run(actions.toggleTheme)}
            className={item}
          >
            <Moon aria-hidden className="size-4 text-muted dark:hidden" />
            <Sun aria-hidden className="hidden size-4 text-muted dark:block" /> Toggle dark mode
          </Command.Item>
          <Command.Item
            value="keyboard shortcuts help"
            onSelect={run(actions.showShortcuts)}
            className={item}
          >
            <span aria-hidden className="w-4 text-center text-muted">
              ?
            </span>{' '}
            Keyboard shortcuts
          </Command.Item>
          <Command.Item value="sign out log out" onSelect={run(actions.signOut)} className={item}>
            <LogOut aria-hidden className="size-4 text-muted" /> Sign out
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
