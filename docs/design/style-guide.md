# Style guide

- Status: Accepted (#231)
- Source of truth: `apps/web/src/styles/tokens.css` (tokens), the living page at **`/styleguide`**
- Implemented by: #32 (design system, `apps/web/src/components/ui.tsx`); used by every screen
- Accessibility is enforced by `apps/web/src/styles/tokens.test.ts` (WCAG contrast for every pair below)

## 1. Personality
**Calm and trustworthy.** Money can be stressful. Fiscus should feel like things are under
control: quiet neutrals, one confident accent, generous whitespace, and no alarm unless something
needs attention.

| Do | Don't |
|---|---|
| Use one accent color for actions and focus | Decorate with gradients or many colors |
| Reserve red for real problems | Paint every expense red |
| Let numbers breathe; align them | Crowd screens with borders and boxes |
| Use plain, neutral language | Blame ("You overspent!"), cutesy jokes, gendered words |

## 2. Color

### Neutrals
A cool gray with a faint green cast, so the accent feels native.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f6f7f6` | `#0c1110` | App canvas |
| `--surface` | `#ffffff` | `#131a18` | Cards, sidebar, dialogs |
| `--surface-2` | `#eef1ef` | `#1a2321` | Hover, selected rows, subtle fills |
| `--border` / `--border-strong` | `#dfe4e1` / `#c8d0cc` | `#283330` / `#36443f` | Dividers / inputs |
| `--fg` | `#121917` | `#e6ecea` | Primary text (≥ 7:1, AAA) |
| `--muted` | `#55605b` | `#9eaaa5` | Secondary text (≥ 4.5:1) |
| `--subtle` | `#6e7974` | `#808c87` | Icons, large hints only (≥ 3:1) |

### Accent: deep teal-green
| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#0e6b57` | `#3dc9a4` | Primary buttons, active nav, focus ring, selected lens |
| `--accent-hover` | `#0a5646` | `#5ad6b5` | Hover/pressed |
| `--accent-soft` | `#e2f0eb` | `#12302a` | Selected backgrounds, success alerts |
| `--accent-text` | `#0b5d4b` | `#5ad6b5` | Accent-colored text and links on surfaces |
| `--accent-fg` | `#ffffff` | `#04201a` | Text on the accent |

The accent is teal-leaning on purpose, so it never reads as "money in" green.

### Semantic
| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--positive` | `#17773a` | `#58d58a` | Money in, goal reached, on track |
| `--danger` (+ `-soft`) | `#b8322a` | `#ff8b7e` | Overdraft, overspent, destructive action, errors |
| `--warning` (+ `-soft`) | `#8f5300` | `#f2b455` | Needs attention soon (bill due, login required) |

**Never rely on color alone** (WCAG 1.4.1). Pair color with a sign, icon, or words.

## 3. Typography
- **Inter** (variable), **bundled with the app** via `@fontsource-variable/inter` (OFL). It's
  never fetched from Google or any CDN: private, and it works on an offline LAN.
- **Tabular figures** (`.amount` / `.tabular`) wherever numbers align: lists, tables, totals.

| Role | Size / weight | Tailwind |
|---|---|---|
| Display | 30 / 600, tight tracking | `text-3xl font-semibold tracking-tight` |
| Page title | 24 / 600 | `text-2xl font-semibold` |
| Section title | 18 / 600 | `text-lg font-semibold` |
| Body | 16 / 400 | `text-base` |
| Secondary | 14 / 400, muted | `text-sm text-muted` |
| Caption, labels | 12 / 400–500, muted | `text-xs text-muted` |

Body text never goes below 14 px on phones. Use sentence case for headings and buttons ("Create
household", not "Create Household").

## 4. Money on screen
The `<Amount>` component (`apps/web/src/components/Amount.tsx`) implements these rules. Don't
format money by hand.

| Case | Look | Example |
|---|---|---|
| Money in (flow > 0) | `--positive`, "+" sign | **+$2,410.00** |
| Money out (flow < 0) | Plain text, true minus "−" (U+2212) | −$84.12 |
| Balance ≥ 0 | Plain | $5,132.06 |
| Negative balance, overspent budget | `--danger` | **−$120.00** |
| Liability (credit card, loan): what you owe | Plain, true minus (`kind="liability"`) | −$287,654.00 |
| Zero | Plain, no sign | $0.00 |

- Formatting uses `formatMoney()` with the household's currency and the viewer's locale.
- Screen readers hear "Received $2,410.00" / "Spent $84.12", not "plus" and "minus".
- Amounts are right-aligned in tables and lists.

## 5. Members
Each member gets an identity color (assigned in join order; `MEMBER_COLORS` in `@fiscus/shared`)
for avatars, lens chips, and attribution dots:

`#2f6fdb` blue · `#c2410c` orange · `#7c4dcc` violet · `#be3d86` magenta · `#0e7490` cyan ·
`#6b7d1f` olive · `#9a5b34` brown · `#5d6f8a` slate

They avoid the semantic red and green, carry white initials at ≥ 4.5:1, and show ≥ 3:1 against
light and dark surfaces. Always show a name or initials with the color, never color alone.

## 6. Charts
Categorical palette `--chart-1` … `--chart-8`, based on Okabe–Ito (safe for the common color-vision
deficiencies), with separate light and dark variants, each ≥ 3:1 against the surface (WCAG 1.4.11).
- Always label series directly or with a legend. Never encode meaning in color alone.
- Money in/out charts use `--positive` and `--muted`, not red/green, so spending doesn't look like an error.
- Gridlines use `--border`; axis text uses `--muted` at 12 px.
- The ECharts theme (M7) reads these CSS variables at runtime, so charts follow the theme.

## 7. Shape, space, depth, motion
- **Spacing:** Tailwind's 4 px scale. Page padding 16 px on phones and 32 px on desktop; card
  padding 20 px; gaps between related items 8–12 px, between sections 24–48 px.
- **Radii:** `sm` 6 · `md` 8 (inputs, buttons) · `lg` 12 (cards, menus) · `xl` 16 (dialogs, sheets).
- **Elevation:** `shadow-sm` (cards, optional), `shadow-md` (menus, popovers), `shadow-lg`
  (dialogs, palette). Dark mode leans on borders, since shadows read poorly there.
- **Motion:** 150–200 ms with `--ease-standard`. Animate opacity and transform only. Respect
  `prefers-reduced-motion` (globally reduced).
- **Focus:** a 2 px accent outline with 2 px offset, on every interactive element. Never remove it.

## 8. Density
**Comfortable** by default (48 px rows). A **compact** option (36 px rows) sits on the
transactions list, where it matters most (#351). It's stored per device and applied before first paint. Lists and tables use `var(--row-h)` and
`var(--cell-px)` so they follow the setting. Touch targets stay ≥ 44 px on phones in either mode.

## 9. Icons
**Lucide**, outline style, `strokeWidth` 1.75, at 16 px (inline, nav), 20 px (phone tabs,
buttons), and 24 px (empty states). Decorative icons are `aria-hidden`; icon-only buttons need an
`aria-label`.

## 10. Voice and tone
- Plain, calm, specific: "Your bank needs you to sign in again to keep syncing." not "Sync error 0x12".
- **Gender-neutral and viewer-relative:** *Mine · [name]'s · Ours*; "partner", "member", "they".
- No blame and no exclamation marks for problems: "Dining out is $120 over budget this month."
- Errors say what happened and what to do next. Successes are brief ("Split saved.").
- Numbers keep their context: "$84.12 at Trader Joe's", not "84.12".

## 11. Components
Built on [React Aria Components](https://react-spectrum.adobe.com/react-aria/) (Adobe, Apache-2.0)
for keyboard, screen-reader, and touch behavior, styled with these tokens. Import from
`components/ui.tsx`; every component is on `/styleguide`.

| Need | Use | Notes |
|---|---|---|
| An action | `Button` (`primary` · `secondary` · `ghost` · `danger`) | `onPress`, not `onClick`. `isPending` shows progress and blocks repeat presses. One primary per view |
| A link that looks like a button | `ButtonLink` | Never put a button inside a link |
| Text entry | `TextField` inside `Form` | Server errors: `validationErrors={err?.fieldErrors()}`; each clears when edited |
| Money entry | `AmountInput` | Value in and out is integer minor units; typed in the viewer's format; up to 15 significant digits |
| A date / a custom range | `DatePicker` / `DateRangePicker` | Values are `"YYYY-MM-DD"` calendar dates |
| Showing a date | `DateText` | Calendar dates never shift; instants use the household's time zone (`TimeZoneProvider`) |
| One of a few options | `SegmentedControl` (2–4), `RadioGroup` / `RadioCard` (needs explanation), `Select` (short list), `ComboBox` (long, searchable) | |
| On/off | `Switch` (takes effect now), `Checkbox` (part of a form) | |
| Ask before something hard to undo | `ConfirmDialog` | Focus starts on the dialog, not the destructive button |
| Anything else modal | `Dialog` (`variant="sheet"` on phones) | Focus is trapped and returns to the trigger |
| A list of actions | `Menu` in `MenuTrigger` | Items take `href` or `onAction` |
| Confirmation after an action | `toast()` | Errors stay until dismissed. Don't toast what's already on screen |
| Status | `Badge`, `Alert` | Words carry the meaning, color reinforces |
| A person | `Avatar` | Color plus initials; hidden from screen readers next to a visible name |
| Data | `Table` | Needs `aria-label`; numbers `align="end"`; rows follow density |
| Loading | `Skeleton` in `LoadingRegion` | |

Touch targets are at least 44 px on phones and 24 px everywhere (WCAG 2.5.8). axe checks
`/styleguide` in CI.

## 12. Changing tokens
1. Edit `tokens.css` (both the light and dark blocks).
2. `pnpm --filter @fiscus/web test` checks every contrast pair; CI fails below AA.
3. Check `/styleguide` in both themes and both densities.
4. Update this document if a rule changes.
