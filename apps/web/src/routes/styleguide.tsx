// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Account, MEMBER_COLORS } from '@fiscus/shared';
import { ArrowLeftRight, Landmark, MoreHorizontal, Pencil, Trash2, Wallet } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { SortDescriptor } from 'react-aria-components';
import { Amount } from '../components/Amount.js';
import { CardDetails } from '../components/CardDetails.js';
import {
  Alert,
  AmountInput,
  Avatar,
  Badge,
  Button,
  Card,
  Cell,
  Checkbox,
  Column,
  ComboBox,
  ConfirmDialog,
  DatePicker,
  DateRangePicker,
  DateText,
  Dialog,
  DialogActions,
  DialogTrigger,
  type IsoRange,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Radio,
  RadioGroup,
  Row,
  SegmentedControl,
  Select,
  SelectItem,
  SelectSection,
  Skeleton,
  Switch,
  Tab,
  Table,
  TableBody,
  TableHeader,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  toast,
  Tooltip,
} from '../components/ui.js';
import { applyDensity, type Density, storedDensity } from '../lib/density.js';
import { applyTheme } from '../lib/theme.js';
import { contrast } from '../styles/contrast.js';

// The living style guide (docs/design/style-guide.md): renders the real tokens and components, so
// it can't drift from the code. Public and data-free, for contributors and design review.

const COLOR_TOKENS = [
  ['Canvas', 'bg'],
  ['Surface', 'surface'],
  ['Surface 2', 'surface-2'],
  ['Border', 'border'],
  ['Text', 'fg'],
  ['Muted text', 'muted'],
  ['Subtle', 'subtle'],
  ['Accent', 'accent'],
  ['Accent soft', 'accent-soft'],
  ['Money in', 'positive'],
  ['Danger', 'danger'],
  ['Warning', 'warning'],
] as const;

function useTokenValues(names: readonly string[]) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setValues(Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [names]);
  return values;
}

const SAMPLE_NAMES = [
  'Alex Kim',
  'Sam',
  'Jordan Lee',
  'Riley',
  'Casey Morgan',
  'Taylor',
  'Quinn',
  'Avery',
];

const CHARTS = Array.from({ length: 8 }, (_, i) => `chart-${i + 1}`);
const ALL = [...COLOR_TOKENS.map(([, t]) => t), ...CHARTS];

export function StyleGuidePage() {
  const v = useTokenValues(ALL);
  const [density, setDensity] = useState<Density>(storedDensity);
  const section = 'space-y-4';
  return (
    <main className="mx-auto max-w-5xl space-y-12 px-4 py-10 md:px-8">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <p className="text-sm font-semibold text-accent-text">Fiscus</p>
          <h1 className="text-3xl font-semibold tracking-tight">Style guide</h1>
          <p className="mt-1 text-muted">
            Calm, trustworthy, and clear about money. Tokens live in{' '}
            <code>src/styles/tokens.css</code>.
          </p>
        </div>
        <Button
          variant="secondary"
          onPress={() =>
            applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')
          }
        >
          Toggle theme
        </Button>
        <SegmentedControl
          aria-label="Density"
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
          value={density}
          onChange={(d) => (setDensity(d), applyDensity(d))}
        />
      </header>

      <section className={section}>
        <h2 className="text-xl font-semibold">Color</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {COLOR_TOKENS.map(([label, token]) => (
            <div key={token} className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className="h-14" style={{ background: `var(--${token})` }} />
              <div className="p-2 text-xs">
                <p className="font-medium">{label}</p>
                <p className="text-muted">
                  --{token} · {v[token]}
                </p>
                {v[token] && v.surface && token !== 'surface' ? (
                  <p className="text-muted">
                    {contrast(v[token]!, v.surface).toFixed(1)}:1 on surface
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Typography</h2>
        <p className="text-sm text-muted">
          Inter (bundled, never loaded from a third party). Figures are tabular wherever amounts
          align.
        </p>
        <Card className="space-y-3">
          <p className="text-3xl font-semibold tracking-tight">Display · 30 / semibold</p>
          <p className="text-2xl font-semibold">Page title · 24 / semibold</p>
          <p className="text-lg font-semibold">Section title · 18 / semibold</p>
          <p className="text-base">Body · 16 / regular. Clear, calm sentences in plain language.</p>
          <p className="text-sm text-muted">Secondary · 14 / regular, muted.</p>
          <p className="text-xs text-muted">Caption · 12 / regular, muted.</p>
          <p className="amount text-2xl font-semibold">$1,234,567.89 · $8,901.10 · $11.11</p>
        </Card>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Money</h2>
        <Card>
          <ul className="divide-y divide-border">
            {[
              [ArrowLeftRight, 'Paycheck', 'Income · Alex', 241000, 'flow'],
              [ArrowLeftRight, "Trader Joe's", 'Groceries · Ours', -8412, 'flow'],
              [Landmark, 'Joint checking', 'Balance', 513206, 'balance'],
              [Wallet, 'Dining out', 'Over budget', -12000, 'balance'],
            ].map(([Icon, title, meta, minor, kind]) => {
              const I = Icon as typeof Landmark;
              return (
                <li
                  key={title as string}
                  className="flex items-center gap-3"
                  style={{ minHeight: 'var(--row-h)', paddingInline: 'var(--cell-px)' }}
                >
                  <I aria-hidden className="size-4 text-muted" strokeWidth={1.75} />
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{title as string}</span>
                    <span className="block text-xs text-muted">{meta as string}</span>
                  </span>
                  <Amount
                    minor={minor as number}
                    currency="USD"
                    kind={kind as 'flow' | 'balance'}
                    className="text-sm font-medium"
                  />
                </li>
              );
            })}
          </ul>
        </Card>
        <p className="text-sm text-muted">
          Money in is green with "+". Money out is plain text with "−". Red is reserved for problems
          (overdraft, overspending). The sign and a screen-reader label always carry the meaning
          too.
        </p>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Members</h2>
        <div className="flex flex-wrap gap-4">
          {MEMBER_COLORS.map((c, i) => (
            <div key={c} className="flex items-center gap-2 text-sm">
              <Avatar name={SAMPLE_NAMES[i] ?? 'Member'} color={c} />
              <span>
                <span className="block">{SAMPLE_NAMES[i]}</span>
                <code className="text-xs text-muted">{c}</code>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Charts</h2>
        <p className="text-sm text-muted">
          Okabe–Ito based, safe for common color-vision deficiencies. Always paired with labels or
          legends.
        </p>
        <div className="flex h-40 items-end gap-2 rounded-lg border border-border bg-surface p-4">
          {CHARTS.map((c, i) => (
            <div key={c} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div
                className="w-full rounded-t-md"
                style={{ background: `var(--${c})`, height: `${30 + ((i * 37) % 60)}%` }}
              />
              <span className="text-[10px] text-muted">{i + 1}</span>
            </div>
          ))}
        </div>
      </section>

      <Buttons />
      <Fields />
      <Choices />
      <Feedback />
      <Overlays />
      <TabsAndTables />
      <Dates />
      {/* The account page's block for a card whose bank reports its details (#86). */}
      <CardDetails account={SAMPLE_CARD} />

      <section className={section}>
        <h2 className="text-xl font-semibold">Shape and depth</h2>
        <div className="flex flex-wrap gap-4">
          {/* Full class names, so Tailwind can see them at build time. */}
          {[
            ['radius sm', 'rounded-sm border border-border'],
            ['radius md', 'rounded-md border border-border'],
            ['radius lg', 'rounded-lg border border-border'],
            ['radius xl', 'rounded-xl border border-border'],
            ['shadow sm', 'rounded-lg shadow-sm'],
            ['shadow md', 'rounded-lg shadow-md'],
            ['shadow lg', 'rounded-lg shadow-lg'],
          ].map(([label, cls]) => (
            <div
              key={label}
              className={`flex size-20 items-center justify-center bg-surface text-xs text-muted ${cls}`}
            >
              {label}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function Demo({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      <Card className="space-y-6">{children}</Card>
    </section>
  );
}

function Buttons() {
  return (
    <Demo
      title="Buttons"
      note="One primary action per view. Danger is for destructive actions only. Icon-only buttons need a label."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Remove</Button>
        <Button isPending>Saving</Button>
        <Button isDisabled>Disabled</Button>
        <Button size="sm" variant="secondary">
          Small
        </Button>
        <Tooltip content="Edit">
          <Button size="icon" variant="ghost" aria-label="Edit">
            <Pencil aria-hidden className="size-4" />
          </Button>
        </Tooltip>
      </div>
    </Demo>
  );
}

const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function Fields() {
  const [cents, setCents] = useState<number | null>(123456);
  return (
    <Demo
      title="Fields"
      note="Labels above, help below, errors replace help. Amounts are typed in your own format and stored as whole cents."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Merchant"
          description="As it appears on statements."
          placeholder="Trader Joe's"
        />
        <TextField
          label="Note"
          isInvalid
          errorMessage="Notes can be up to 500 characters."
          defaultValue="Way too long…"
        />
        <Select label="Category" defaultValue="groceries" searchable>
          <SelectSection title="Food">
            <SelectItem id="groceries">Groceries</SelectItem>
            <SelectItem id="dining">Dining out</SelectItem>
          </SelectSection>
          <SelectSection title="Home">
            <SelectItem id="rent">Rent</SelectItem>
            <SelectItem id="utilities">Utilities</SelectItem>
          </SelectSection>
        </Select>
        <ComboBox label="Time zone" defaultSelectedKey="America/Chicago" menuTrigger="focus">
          {ZONES.map((z) => (
            <SelectItem key={z} id={z}>
              {z}
            </SelectItem>
          ))}
        </ComboBox>
        <AmountInput
          label="Amount (USD)"
          currency="USD"
          value={cents}
          onChange={setCents}
          description={`Stored as ${cents ?? 'nothing'} (minor units).`}
        />
        <AmountInput label="Amount (JPY, no decimals)" currency="JPY" defaultValue={1500} />
        <AmountInput label="Amount (KWD, 3 decimals)" currency="KWD" defaultValue={12345} />
        <AmountInput
          label="Adjustment (can be negative)"
          currency="EUR"
          allowNegative
          defaultValue={-2550}
        />
      </div>
    </Demo>
  );
}

function Choices() {
  const [lens, setLens] = useState<'me' | 'partner' | 'shared' | 'all'>('shared');
  return (
    <Demo title="Choices">
      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-1">
          <Checkbox defaultSelected>Exclude from budget</Checkbox>
          <Checkbox>Business expense</Checkbox>
          <Checkbox isIndeterminate>Some selected</Checkbox>
        </div>
        <div className="space-y-1">
          <Switch defaultSelected>Email me about bills</Switch>
          <Switch>Weekly recap</Switch>
        </div>
        <RadioGroup label="Split" defaultValue="even">
          <Radio value="even">Evenly</Radio>
          <Radio value="income">By income</Radio>
          <Radio value="custom">Custom</Radio>
        </RadioGroup>
      </div>
      <SegmentedControl
        aria-label="Whose money"
        options={[
          { value: 'me', label: 'Mine' },
          { value: 'partner', label: 'Sam' },
          { value: 'shared', label: 'Ours' },
          { value: 'all', label: 'All' },
        ]}
        value={lens}
        onChange={setLens}
      />
    </Demo>
  );
}

function Feedback() {
  return (
    <Demo
      title="Feedback and status"
      note="Say what happened and what to do next. Never color alone."
    >
      <div className="space-y-2">
        <Alert tone="info">Your bank needs you to sign in again to keep syncing.</Alert>
        <Alert tone="success">Split saved.</Alert>
        <Alert tone="warning">Rent is due in 3 days.</Alert>
        <Alert>Couldn't save: someone else changed this first.</Alert>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge>Pending</Badge>
        <Badge tone="accent">Owner</Badge>
        <Badge tone="positive">On track</Badge>
        <Badge tone="warning">Due soon</Badge>
        <Badge tone="danger">Over budget</Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onPress={() => toast('Split saved.')}>
          Show a toast
        </Button>
        <Button
          variant="secondary"
          onPress={() =>
            toast("Couldn't sync Chase", {
              tone: 'error',
              description: 'Sign in to your bank again to keep syncing.',
            })
          }
        >
          Show an error toast
        </Button>
      </div>
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </Demo>
  );
}

function Overlays() {
  return (
    <Demo
      title="Dialogs and menus"
      note="Focus moves into the overlay and returns to the button afterwards. Escape closes."
    >
      <div className="flex flex-wrap gap-2">
        <DialogTrigger>
          <Button variant="secondary">Open dialog</Button>
          <Dialog title="Rename account">
            {(close) => (
              <>
                <TextField label="Name" defaultValue="Joint checking" autoFocus />
                <DialogActions>
                  <Button variant="secondary" onPress={close}>
                    Cancel
                  </Button>
                  <Button onPress={() => (close(), toast('Account renamed.'))}>Save</Button>
                </DialogActions>
              </>
            )}
          </Dialog>
        </DialogTrigger>
        <DialogTrigger>
          <Button variant="danger">Delete rule</Button>
          <ConfirmDialog
            title="Delete this rule?"
            confirmLabel="Delete rule"
            destructive
            onConfirm={() =>
              new Promise((r) => setTimeout(r, 600)).then(() => toast('Rule deleted.'))
            }
          >
            Transactions it already changed stay as they are.
          </ConfirmDialog>
        </DialogTrigger>
        <MenuTrigger>
          <Button variant="ghost" size="icon" aria-label="Transaction actions">
            <MoreHorizontal aria-hidden className="size-4" />
          </Button>
          <Menu>
            <MenuItem onAction={() => toast('Split opened.')}>
              <ArrowLeftRight aria-hidden /> Split
            </MenuItem>
            <MenuItem onAction={() => toast('Editing.')}>
              <Pencil aria-hidden /> Edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem tone="danger" onAction={() => toast('Deleted.')}>
              <Trash2 aria-hidden /> Delete
            </MenuItem>
          </Menu>
        </MenuTrigger>
      </div>
    </Demo>
  );
}

const ROWS = [
  {
    id: 1,
    date: '2026-09-30',
    merchant: "Trader Joe's",
    category: 'Groceries',
    who: 'Ours',
    minor: -8412,
  },
  {
    id: 2,
    date: '2026-09-29',
    merchant: 'Paycheck',
    category: 'Income',
    who: 'Alex',
    minor: 241000,
  },
  {
    id: 3,
    date: '2026-09-28',
    merchant: 'City Utilities',
    category: 'Utilities',
    who: 'Ours',
    minor: -13250,
  },
  {
    id: 4,
    date: '2026-09-27',
    merchant: 'Corner Café',
    category: 'Dining out',
    who: 'Sam',
    minor: -1875,
  },
];

function TabsAndTables() {
  const [sort, setSort] = useState<SortDescriptor>({ column: 'date', direction: 'descending' });
  const rows = useMemo(() => {
    const key = sort.column as keyof (typeof ROWS)[number];
    const sorted = [...ROWS].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
    return sort.direction === 'descending' ? sorted.reverse() : sorted;
  }, [sort]);
  return (
    <Demo
      title="Tabs and tables"
      note="Rows follow the density setting. Amounts are right-aligned with tabular figures."
    >
      <Tabs>
        <TabList aria-label="Views">
          <Tab id="table">Transactions</Tab>
          <Tab id="empty">Loading</Tab>
        </TabList>
        <TabPanel id="table" className="-mx-5 overflow-x-auto">
          <Table
            aria-label="Recent transactions"
            selectionMode="multiple"
            sortDescriptor={sort}
            onSortChange={setSort}
          >
            <TableHeader>
              <Column id="date" allowsSorting isRowHeader={false}>
                Date
              </Column>
              <Column id="merchant" allowsSorting isRowHeader>
                Merchant
              </Column>
              <Column id="category">Category</Column>
              <Column id="who">Whose</Column>
              <Column id="minor" allowsSorting align="end">
                Amount
              </Column>
            </TableHeader>
            <TableBody items={rows}>
              {(r) => (
                <Row id={r.id}>
                  <Cell className="text-muted">
                    <DateText value={r.date} format="short" />
                  </Cell>
                  <Cell className="font-medium">{r.merchant}</Cell>
                  <Cell>{r.category}</Cell>
                  <Cell>
                    <Badge>{r.who}</Badge>
                  </Cell>
                  <Cell align="end">
                    <Amount minor={r.minor} currency="USD" />
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </TabPanel>
        <TabPanel id="empty" className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3" aria-hidden>
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </TabPanel>
      </Tabs>
    </Demo>
  );
}

const SAMPLE_CARD: Account = {
  id: '00000000-0000-7000-8000-000000000001',
  name: 'Visa',
  type: 'credit',
  subtype: null,
  currency: 'USD',
  mask: '4821',
  visibility: 'full',
  balanceMode: 'transactions',
  includeInNetWorth: true,
  isBusiness: false,
  sortOrder: 0,
  closedAt: null,
  owners: [],
  yourAccess: 'owner',
  balance: { amountMinor: -128_455, asOf: '2026-10-20' },
  liabilities: {
    aprBps: 2149,
    minimumPaymentMinor: 3_500,
    nextDueDate: '2026-10-25',
    lastStatementBalanceMinor: -142_310,
    lastStatementDate: '2026-09-28',
    updatedAt: '2026-10-20T11:00:00.000Z',
  },
  version: 1,
};

function Dates() {
  const [range, setRange] = useState<IsoRange | null>({ start: '2026-09-01', end: '2026-09-30' });
  return (
    <Demo
      title="Dates"
      note="Calendar dates (a posted date) never shift. Times are shown in the household's time zone. Formats follow your language."
    >
      <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
        <dt className="text-muted">Date</dt>
        <dd>
          <DateText value="2026-09-30" />
        </dd>
        <dt className="text-muted">Short</dt>
        <dd>
          <DateText value="2026-09-30" format="short" />
        </dd>
        <dt className="text-muted">Month</dt>
        <dd>
          <DateText value="2026-09-30" format="month" />
        </dd>
        <dt className="text-muted">Date and time</dt>
        <dd>
          <DateText value="2026-09-30T21:05:00Z" format="datetime" />
        </dd>
      </dl>
      <div className="grid gap-4 md:grid-cols-2">
        <DatePicker label="Due date" defaultValue="2026-10-15" />
        <DateRangePicker
          label="Custom range"
          value={range}
          onChange={setRange}
          description={range ? `${range.start} to ${range.end}` : 'No range'}
        />
      </div>
    </Demo>
  );
}
