// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AccountType,
  type CategoryKind,
  type CsvMapping,
  CsvError,
  detectDateFormat,
  headerSignature,
  type ImportPreview,
  type ImportRowResult,
  minorUnitExponent,
  parseCsv,
  profileFits,
  suggestMapping,
} from '@fiscus/shared';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useBlocker, useParams } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ProgressBar } from 'react-aria-components';
import { api, ApiError } from '../api/client.js';
import {
  accountsQuery,
  categoriesQuery,
  householdQuery,
  importCategoryMapQuery,
  importProfilesQuery,
  membersQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  ConfirmDialog,
  DateText,
  FileDrop,
  LoadingRegion,
  RadioCard,
  RadioGroup,
  SegmentedControl,
  Select,
  SelectItem,
  SelectSection,
  Skeleton,
  Switch,
  TextField,
  toast,
} from '../components/ui.js';
import {
  type AccountChoice,
  type CategoryChoice,
  type CheckReason,
  chooseAccount,
  chooseMany,
  continuationGap,
  classifyFile,
  combinedInto,
  combineTargets,
  type FileRows,
  type ImportState,
  type LoadedFile,
  type Progress,
  previewImport,
  previewRequest,
  readCsvFile,
  readMonarchFiles,
  sendRows,
  startImport,
  suggestAccounts,
  suggestCategories,
  summarize,
  undoRun,
  withType,
  type WizardChoices,
} from '../lib/import.js';

// The import wizard (docs/design/imports.md §1): source → columns (CSV) → accounts → categories
// → review → done. Nothing is saved until "Import"; Back keeps every choice.

type Source = 'monarch' | 'csv';
type StepId = 'source' | 'columns' | 'accounts' | 'categories' | 'review' | 'done';

const STEP_LABELS: Record<StepId, string> = {
  source: 'Source',
  columns: 'Columns',
  accounts: 'Accounts',
  categories: 'Categories',
  review: 'Review',
  done: 'Import',
};

const TYPE_LABELS: Record<AccountType, string> = {
  depository: 'Checking or savings',
  credit: 'Credit card',
  loan: 'Loan',
  investment: 'Investment',
  property: 'Property',
  vehicle: 'Vehicle',
  crypto: 'Crypto',
  other: 'Other',
};

const KIND_OPTIONS = [
  { value: 'flexible', label: 'Spending' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
] as const;

const n = (x: number) => x.toLocaleString('en-US');

export function ImportPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const exponent = minorUnitExponent(household.baseCurrency);
  const accounts = useQuery(accountsQuery(householdId, 'all', 'closed')).data ?? [];
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const profiles = useQuery(importProfilesQuery(householdId)).data ?? [];
  const queryClient = useQueryClient();

  const [step, setStep] = useState<StepId>('source');
  const [source, setSource] = useState<Source>('monarch');
  const remembered = useQuery(importCategoryMapQuery(householdId, source)).data ?? {};
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Partial<CsvMapping>>({});
  const [profileId, setProfileId] = useState<string | undefined>();
  const [rows, setRows] = useState<FileRows | null>(null);
  const [accountChoices, setAccountChoices] = useState<AccountChoice[]>([]);
  const [categoryChoices, setCategoryChoices] = useState<CategoryChoice[]>([]);
  const [memberChoices, setMemberChoices] = useState<{ name: string; memberId: string | null }[]>(
    [],
  );
  const [includeOverlaps, setIncludeOverlaps] = useState<Set<number>>(new Set());

  const hasCategories = (rows?.transactions ?? []).some((t) => t.category?.trim());
  const steps: StepId[] = [
    'source',
    ...(source === 'csv' ? (['columns'] as const) : []),
    'accounts',
    ...(hasCategories ? (['categories'] as const) : []),
    'review',
    'done',
  ];
  const index = steps.indexOf(step);
  const go = (to: StepId) => {
    setStep(to);
    // Focus moves to the step's heading (a11y); see StepHeading.
  };
  const next = () => go(steps[index + 1]!);
  const back = () => go(steps[index - 1]!);

  const choices: WizardChoices = {
    format: source,
    filename:
      files
        .map((f) => f.name)
        .join(', ')
        .slice(0, 255) || 'import.csv',
    ...(profileId ? { profileId } : {}),
    accounts: accountChoices,
    categories: categoryChoices,
    members: memberChoices,
  };

  /** Reads the files (and mapping, for CSV) into rows, and sets first choices for later steps. */
  const prepare = (loaded: FileRows) => {
    setRows(loaded);
    setAccountChoices(suggestAccounts(loaded.monarchAccounts, accounts));
    setCategoryChoices(suggestCategories(loaded.transactions, groups, remembered));
    setMemberChoices(
      loaded.owners.map((name) => ({
        name,
        memberId:
          members.find((m) => m.displayName.trim().toLowerCase() === name.toLowerCase())?.id ??
          null,
      })),
    );
    setIncludeOverlaps(new Set());
  };

  const loadFiles = async (list: File[]) => {
    setFileError(null);
    try {
      const loaded = await Promise.all(
        list.map(async (f) => {
          const table = parseCsv(await f.text());
          return { name: f.name, table, kind: classifyFile(table) } satisfies LoadedFile;
        }),
      );
      if (source === 'monarch') {
        const merged = [...files, ...loaded].filter(
          (f, i, all) => all.findLastIndex((g) => g.kind === f.kind) === i,
        );
        if (merged.some((f) => f.kind === 'csv')) {
          setFileError(
            'That doesn’t look like a Monarch export. Choose the Transactions or Balances file from Monarch, or switch to “A bank or card statement”.',
          );
          return;
        }
        setFiles(merged);
      } else {
        const file = loaded[0]!;
        setFiles([file]);
        const fit = profiles.find((p) => profileFits(p.mapping, file.table.headers));
        if (fit) {
          setMapping(fit.mapping);
          setProfileId(fit.id);
        } else {
          setMapping(suggestMapping(file.table));
          setProfileId(undefined);
        }
      }
    } catch (err) {
      setFileError(
        err instanceof CsvError
          ? `This file can’t be read (line ${err.line}): ${err.message}.`
          : 'This file can’t be read as a CSV file.',
      );
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <div>
        <h1 className="text-2xl font-semibold">Import</h1>
        <p className="text-sm text-muted">
          Bring in history from Monarch or a bank’s CSV file. Nothing is saved until the last step.
        </p>
      </div>
      <Stepper steps={steps} current={step} />

      {step === 'source' ? (
        <SourceStep
          source={source}
          onSource={(s) => {
            setSource(s);
            setFiles([]);
            setFileError(null);
          }}
          files={files}
          error={fileError}
          onFiles={(f) => void loadFiles(f)}
          onRemove={(name) => setFiles(files.filter((f) => f.name !== name))}
          onNext={() => {
            if (source === 'monarch') prepare(readMonarchFiles(files, exponent));
            next();
          }}
        />
      ) : null}

      {step === 'columns' && files[0] ? (
        <ColumnsStep
          householdId={householdId}
          file={files[0]}
          mapping={mapping}
          onMapping={(m) => {
            setMapping(m);
            setProfileId(undefined);
          }}
          profileName={profiles.find((p) => p.id === profileId)?.name}
          exponent={exponent}
          onBack={back}
          onNext={async (complete, saveAs) => {
            if (saveAs) {
              try {
                const r = await api<{ data: { id: string } }>(
                  'POST',
                  `/api/v1/households/${householdId}/import-profiles`,
                  {
                    body: {
                      name: saveAs,
                      headers: headerSignature(files[0]!.table.headers),
                      mapping: complete,
                    },
                  },
                );
                setProfileId(r.data.id);
                void queryClient.invalidateQueries({
                  queryKey: importProfilesQuery(householdId).queryKey,
                });
              } catch (err) {
                toast(err instanceof ApiError ? err.title : 'The mapping wasn’t saved.');
              }
            }
            prepare(readCsvFile(files[0]!, complete, exponent));
            next();
          }}
        />
      ) : null}

      {step === 'accounts' ? (
        <AccountsStep
          choices={accountChoices}
          onChange={setAccountChoices}
          accounts={accounts.filter((a) => a.yourAccess === 'owner')}
          currency={household.baseCurrency}
          people={memberChoices}
          onPeople={setMemberChoices}
          members={members}
          problems={rows?.problems.length ?? 0}
          onBack={back}
          onNext={next}
        />
      ) : null}

      {step === 'categories' ? (
        <CategoriesStep
          choices={categoryChoices}
          onChange={setCategoryChoices}
          groups={groups}
          source={source}
          onBack={back}
          onNext={next}
        />
      ) : null}

      {step === 'review' && rows ? (
        <ReviewStep
          householdId={householdId}
          choices={choices}
          rows={rows}
          currency={household.baseCurrency}
          includeOverlaps={includeOverlaps}
          onIncludeOverlaps={setIncludeOverlaps}
          onBack={back}
          onNext={next}
        />
      ) : null}

      {step === 'done' && rows ? (
        <DoneStep
          householdId={householdId}
          choices={choices}
          rows={rows}
          includeOverlaps={includeOverlaps}
          onFinished={() =>
            void queryClient.invalidateQueries({ queryKey: ['households', householdId] })
          }
        />
      ) : null}
    </div>
  );
}

/** Where you are: done steps are ticked, the current one is marked for screen readers. */
function Stepper({ steps, current }: { steps: StepId[]; current: StepId }) {
  const at = steps.indexOf(current);
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm" aria-label="Import steps">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={s === current ? 'step' : undefined}
          className={s === current ? 'font-semibold text-fg' : i < at ? 'text-fg' : 'text-muted'}
        >
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className={
                'flex size-5 items-center justify-center rounded-full text-xs ' +
                (i < at
                  ? 'bg-accent text-accent-fg'
                  : s === current
                    ? 'border-2 border-accent'
                    : 'border border-border-strong')
              }
            >
              {i < at ? <Check className="size-3" /> : i + 1}
            </span>
            {STEP_LABELS[s]}
            {i < at ? <span className="sr-only"> (done)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Each step's heading takes focus when the step appears, so screen readers announce it. */
function StepHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h2 ref={ref} tabIndex={-1} className="text-lg font-semibold">
      {children}
    </h2>
  );
}

function StepActions({
  onBack,
  onNext,
  nextLabel = 'Continue',
  nextDisabled,
  isPending,
  children,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  isPending?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
      {children ? <div className="mr-auto text-sm text-muted">{children}</div> : null}
      {onBack ? (
        <Button variant="secondary" onPress={onBack}>
          Back
        </Button>
      ) : null}
      {onNext ? (
        <Button onPress={onNext} isDisabled={!!nextDisabled} isPending={!!isPending}>
          {nextLabel}
        </Button>
      ) : null}
    </div>
  );
}

// ── 1. Source ──────────────────────────────────────────────────────────────────────────────

function SourceStep({
  source,
  onSource,
  files,
  error,
  onFiles,
  onRemove,
  onNext,
}: {
  source: Source;
  onSource: (s: Source) => void;
  files: LoadedFile[];
  error: string | null;
  onFiles: (f: File[]) => void;
  onRemove: (name: string) => void;
  onNext: () => void;
}) {
  const monarch = source === 'monarch';
  const ready = monarch
    ? files.some((f) => f.kind === 'monarch-transactions' || f.kind === 'monarch-balances')
    : files.length === 1;
  return (
    <Card className="space-y-5">
      <StepHeading>Where is it from?</StepHeading>
      <RadioGroup
        aria-label="Source"
        value={source}
        onChange={(v) => onSource(v as Source)}
        className="grid gap-2 md:grid-cols-2"
      >
        <RadioCard
          value="monarch"
          title="Monarch"
          description="Your transactions and, optionally, balance history, with categories, tags, and notes."
        />
        <RadioCard
          value="csv"
          title="A bank or card statement"
          description="A CSV file from your bank. You’ll match its columns next."
        />
      </RadioGroup>
      <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
        <FileDrop
          label={monarch ? 'Drop your Monarch files here' : 'Drop the CSV file here'}
          description={
            monarch
              ? 'The Transactions file, the Balances file, or both. They stay on this device until you import.'
              : 'It stays on this device until you import.'
          }
          accept={['text/csv', '.csv']}
          allowsMultiple={monarch}
          onFiles={onFiles}
        />
        {monarch ? (
          <aside className="space-y-2 text-sm text-muted">
            <h3 className="font-medium text-fg">Exporting from Monarch</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>In Monarch, open Settings → Data.</li>
              <li>Choose “Download transactions”.</li>
              <li>
                For balance history too, choose “Download balances”: one file covers every account.
              </li>
            </ol>
          </aside>
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {files.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
              <Badge>
                {f.kind === 'monarch-transactions'
                  ? `Transactions · ${n(f.table.rows.length)} rows`
                  : f.kind === 'monarch-balances'
                    ? `Balances · ${n(f.table.rows.length)} rows`
                    : `${n(f.table.rows.length)} rows`}
              </Badge>
              <Button variant="ghost" size="sm" onPress={() => onRemove(f.name)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {monarch && files.length === 1 && files[0]!.kind === 'monarch-transactions' ? (
        <p className="text-sm text-muted">
          Without the Balances file, each account’s history starts with its transactions, and
          accounts that only have balances (a car, investments) aren’t imported.
        </p>
      ) : null}
      <StepActions onNext={onNext} nextDisabled={!ready} />
    </Card>
  );
}

// ── 2. Columns (CSV) ───────────────────────────────────────────────────────────────────────

function ColumnsStep({
  file,
  mapping,
  onMapping,
  profileName,
  exponent,
  onBack,
  onNext,
}: {
  householdId: string;
  file: LoadedFile;
  mapping: Partial<CsvMapping>;
  onMapping: (m: Partial<CsvMapping>) => void;
  profileName: string | undefined;
  exponent: number;
  onBack: () => void;
  onNext: (m: CsvMapping, saveAs: string | null) => Promise<void>;
}) {
  const headers = file.table.headers;
  const [editing, setEditing] = useState(!profileName);
  const [save, setSave] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<CsvMapping>) => onMapping({ ...mapping, ...patch });
  const dateSamples = useMemo(() => {
    const i = mapping.date ? headers.indexOf(mapping.date) : -1;
    return i < 0 ? [] : file.table.rows.slice(0, 500).map((r) => r[i] ?? '');
  }, [file, headers, mapping.date]);
  const detection = detectDateFormat(dateSamples);
  const complete =
    mapping.date && mapping.dateFormat && mapping.description && mapping.amount && mapping.decimal
      ? (mapping as CsvMapping)
      : null;
  const sample = complete
    ? readCsvFile(
        {
          ...file,
          table: {
            ...file.table,
            rows: file.table.rows.slice(0, 6),
            lines: file.table.lines.slice(0, 6),
          },
        },
        complete,
        exponent,
      )
    : null;
  const all = complete ? readCsvFile(file, complete, exponent) : null;

  const column = (
    label: string,
    value: string | undefined,
    onChange: (v: string | undefined) => void,
    optional = false,
  ) => (
    <Select
      label={label}
      value={value ?? (optional ? '__none' : null)}
      onChange={(v) => onChange(v === '__none' || v === null ? undefined : String(v))}
    >
      {[
        ...(optional
          ? [
              <SelectItem key="__none" id="__none">
                Not in this file
              </SelectItem>,
            ]
          : []),
        ...headers.map((h) => (
          <SelectItem key={h} id={h}>
            {h}
          </SelectItem>
        )),
      ]}
    </Select>
  );

  return (
    <Card className="space-y-5">
      <StepHeading>Match the columns</StepHeading>
      {profileName && !editing ? (
        <Alert tone="info">
          Using your saved mapping <strong>{profileName}</strong>.{' '}
          <Button variant="ghost" size="sm" onPress={() => setEditing(true)}>
            Change
          </Button>
        </Alert>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {column('Date', mapping.date, (date) => set({ date, dateFormat: undefined }))}
          <Select
            label="Date format"
            value={mapping.dateFormat ?? detection.formats[0] ?? null}
            onChange={(v) => set({ dateFormat: v as CsvMapping['dateFormat'] })}
            description={
              detection.ambiguous
                ? 'Every day in this file is 12 or less, so check: is 03/04 March 4 or April 3?'
                : undefined
            }
          >
            <SelectItem id="ymd">2026-10-06</SelectItem>
            <SelectItem id="mdy">10/06/2026 (month first)</SelectItem>
            <SelectItem id="dmy">06/10/2026 (day first)</SelectItem>
            <SelectItem id="text">Oct 6, 2026</SelectItem>
          </Select>
          {column('Description', mapping.description, (description) => set({ description }))}
          <div className="space-y-2 md:col-span-3">
            <SegmentedControl
              aria-label="Amount columns"
              options={[
                { value: 'signed', label: 'One amount column' },
                { value: 'split', label: 'Separate debit and credit' },
              ]}
              value={mapping.amount?.kind ?? 'signed'}
              onChange={(kind) =>
                set({
                  amount:
                    kind === 'signed'
                      ? { kind, column: headers[0]!, negate: false }
                      : { kind, debit: headers[0]!, credit: headers[0]! },
                })
              }
            />
          </div>
          {mapping.amount?.kind === 'split' ? (
            <>
              {column('Money out (debit)', mapping.amount.debit, (debit) =>
                set({
                  amount: {
                    ...(mapping.amount as { kind: 'split'; credit: string }),
                    kind: 'split',
                    debit: debit ?? '',
                  },
                }),
              )}
              {column('Money in (credit)', mapping.amount.credit, (credit) =>
                set({
                  amount: {
                    ...(mapping.amount as { kind: 'split'; debit: string }),
                    kind: 'split',
                    credit: credit ?? '',
                  },
                }),
              )}
            </>
          ) : (
            <>
              {column('Amount', mapping.amount?.column, (c) =>
                set({
                  amount: {
                    kind: 'signed',
                    column: c ?? '',
                    negate: mapping.amount?.kind === 'signed' && mapping.amount.negate,
                  },
                }),
              )}
              <Switch
                isSelected={mapping.amount?.kind === 'signed' && mapping.amount.negate}
                onChange={(negate) =>
                  set({
                    amount: {
                      kind: 'signed',
                      column: (mapping.amount as { column?: string })?.column ?? '',
                      negate,
                    },
                  })
                }
                className="md:mt-7"
              >
                Spending shows as positive
              </Switch>
            </>
          )}
          <Select
            label="Decimal separator"
            value={mapping.decimal ?? '.'}
            onChange={(v) => set({ decimal: v as '.' | ',' })}
          >
            <SelectItem id=".">1,234.56</SelectItem>
            <SelectItem id=",">1.234,56</SelectItem>
          </Select>
          {column('Name (optional)', mapping.name, (name) => set({ name }), true)}
          {column('Category (optional)', mapping.category, (category) => set({ category }), true)}
          {column('Notes (optional)', mapping.notes, (notes) => set({ notes }), true)}
          {column('Account (optional)', mapping.account, (account) => set({ account }), true)}
          {column('Transaction ID (optional)', mapping.id, (id) => set({ id }), true)}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium">How the first rows read</h3>
        {sample ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1 pr-4 font-medium">Date</th>
                  <th className="py-1 pr-4 font-medium">Description</th>
                  <th className="py-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {sample.transactions.map((t) => (
                  <tr key={t.line} className="border-t border-border">
                    <td className="py-1 pr-4 whitespace-nowrap">
                      <DateText value={t.date} />
                    </td>
                    <td className="max-w-80 truncate py-1 pr-4">{t.name ?? t.description}</td>
                    <td className="py-1 text-right">
                      <Amount minor={t.amountMinor} currency="USD" />
                    </td>
                  </tr>
                ))}
                {sample.problems.map((p) => (
                  <tr key={p.line} className="border-t border-border text-danger">
                    <td colSpan={3} className="py-1">
                      Line {p.line}: {p.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">Choose the date, description, and amount columns.</p>
        )}
        {all && all.problems.length ? (
          <p className="mt-2 text-sm text-warning">
            {n(all.problems.length)} of {n(file.table.rows.length)} rows can’t be read with these
            choices; they’ll be listed in the review and left out.
          </p>
        ) : null}
      </div>

      {editing || !profileName ? (
        <div className="flex flex-wrap items-end gap-3">
          <Checkbox isSelected={save} onChange={setSave}>
            Save this mapping for this bank’s next file
          </Checkbox>
          {save ? (
            <TextField
              label="Mapping name"
              value={saveName}
              onChange={setSaveName}
              placeholder="Chase checking"
              className="w-64"
            />
          ) : null}
        </div>
      ) : null}

      <StepActions
        onBack={onBack}
        onNext={async () => {
          setPending(true);
          await onNext(complete!, save && saveName.trim() ? saveName.trim() : null);
          setPending(false);
        }}
        nextDisabled={!complete || (all?.transactions.length ?? 0) === 0}
        isPending={pending}
      />
    </Card>
  );
}

// ── 3. Accounts ────────────────────────────────────────────────────────────────────────────

/** Why an account is in "Check these". A leftover balance on a card or loan is owed, not held. */
const checkLabel = (reason: CheckReason, c: AccountChoice): string =>
  ({
    duplicate: 'Possible copy',
    continued: 'Continues in another account',
    closed_with_money:
      (c.lastBalance ?? 0) < 0 ? 'Closed with a balance owed?' : 'Closed with money in it?',
    type_unsure: 'Check the type',
  })[reason];

type ExistingAccount = { id: string; name: string; closedAt: string | null };

function AccountsStep({
  choices,
  onChange,
  accounts,
  currency,
  people,
  onPeople,
  members,
  problems,
  onBack,
  onNext,
}: {
  choices: AccountChoice[];
  onChange: (c: AccountChoice[]) => void;
  accounts: ExistingAccount[];
  currency: string;
  people: { name: string; memberId: string | null }[];
  onPeople: (p: { name: string; memberId: string | null }[]) => void;
  members: { id: string; displayName: string }[];
  problems: number;
  onBack: () => void;
  onNext: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Collapsing only helps with a long list: a bank file's one account is always in view.
  const collapsible = choices.length > 5;
  const [showReady, setShowReady] = useState(!collapsible);
  const update = (key: string, patch: Partial<AccountChoice>) =>
    onChange(chooseAccount(choices, key, patch));
  const bulk = (patch: (c: AccountChoice) => Partial<AccountChoice>) => {
    onChange(chooseMany(choices, selected, patch));
    setSelected(new Set());
  };
  const select = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    setSelected(next);
  };
  const toCheck = choices.filter((c) => c.check.length > 0);
  const ready = choices.filter((c) => c.check.length === 0);
  const importing = choices.filter((c) => c.mode !== 'skip').length;
  const closing = choices.filter(
    (c) => c.mode !== 'skip' && c.mode !== 'combine' && c.close,
  ).length;
  const row = (c: AccountChoice) => (
    <AccountRow
      key={c.key}
      choice={c}
      choices={choices}
      accounts={accounts}
      currency={currency}
      selected={selected.has(c.key)}
      onSelect={(on) => select(c.key, on)}
      onUpdate={(patch) => update(c.key, patch)}
    />
  );

  return (
    <Card className="space-y-5">
      <StepHeading>Where does each account go?</StepHeading>
      <p className="text-sm text-muted">
        Each account becomes a new account, goes into one you already have, is combined with another
        account in the file, or is left out. Names, types, and closing can all be changed after
        importing; copies and combining are easiest to get right here.
      </p>
      {problems ? (
        <Alert tone="warning">
          {n(problems)} {problems === 1 ? 'row' : 'rows'} in the file can’t be read and will be left
          out.
        </Alert>
      ) : null}

      {selected.size ? (
        <div
          role="toolbar"
          aria-label="Change the selected accounts"
          className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2 text-sm"
        >
          <span className="px-1 font-medium">{n(selected.size)} selected</span>
          <Select
            aria-label="Set the type of the selected accounts"
            placeholder="Set type"
            value={null}
            onChange={(v) => v && bulk((c) => ({ ...withType(c, v as AccountType) }))}
            triggerClassName="min-w-40"
          >
            {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
              <SelectItem key={t} id={t}>
                {TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => bulk(() => ({ mode: 'new', accountId: null, sameAs: null }))}
          >
            New accounts
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => bulk(() => ({ mode: 'skip', accountId: null, sameAs: null }))}
          >
            Don’t import
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => bulk((c) => ({ close: !!c.closeOn }))}
          >
            Closed
          </Button>
          <Button variant="secondary" size="sm" onPress={() => bulk(() => ({ close: false }))}>
            Not closed
          </Button>
          <Button variant="ghost" size="sm" onPress={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {toCheck.length ? (
        <section className="space-y-2" aria-labelledby="check-these">
          <h3 id="check-these" className="text-sm font-medium">
            Check these ({n(toCheck.length)})
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {toCheck.map(row)}
          </ul>
        </section>
      ) : null}

      {ready.length ? (
        <section className="space-y-2" aria-labelledby="ready">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id="ready" className="text-sm font-medium">
              Ready to import ({n(ready.length)})
            </h3>
            {collapsible ? (
              <span className="text-sm text-muted">
                {ready.some((c) => c.mode === 'existing')
                  ? 'Matched to your accounts by name, or new with the type their name says.'
                  : 'New accounts with the type their name says.'}
              </span>
            ) : null}
            {collapsible ? (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showReady}
                aria-controls="ready-list"
                onPress={() => setShowReady(!showReady)}
              >
                {showReady ? 'Hide' : 'Show'}
              </Button>
            ) : null}
          </div>
          {showReady ? (
            <ul id="ready-list" className="divide-y divide-border rounded-lg border border-border">
              {ready.map(row)}
            </ul>
          ) : null}
        </section>
      ) : null}

      {people.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">People in the file</h3>
          <p className="text-sm text-muted">
            Monarch’s Owner column says who a transaction was for. Match each name to a member, or
            choose nobody.
          </p>
          {people.map((p) => (
            <Select
              key={p.name}
              label={p.name}
              value={p.memberId ?? '__nobody'}
              onChange={(v) =>
                onPeople(
                  people.map((x) =>
                    x.name === p.name ? { ...x, memberId: v === '__nobody' ? null : String(v) } : x,
                  ),
                )
              }
              className="max-w-sm"
            >
              {[
                <SelectItem key="__nobody" id="__nobody">
                  Nobody
                </SelectItem>,
                ...members.map((m) => (
                  <SelectItem key={m.id} id={m.id}>
                    {m.displayName}
                  </SelectItem>
                )),
              ]}
            </Select>
          ))}
        </div>
      ) : null}

      <StepActions onBack={onBack} onNext={onNext} nextDisabled={importing === 0}>
        {n(importing)} of {n(choices.length)} accounts
        {closing ? `, ${n(closing)} closed` : ''}
      </StepActions>
    </Card>
  );
}

/** "the day after", "3 days after". */
const gapText = (days: number | null) =>
  days === null || days <= 1 ? 'the day after' : `${days} days after`;

function AccountRow({
  choice: c,
  choices,
  accounts,
  currency,
  selected,
  onSelect,
  onUpdate,
}: {
  choice: AccountChoice;
  choices: AccountChoice[];
  accounts: ExistingAccount[];
  currency: string;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onUpdate: (patch: Partial<AccountChoice>) => void;
}) {
  const taken = new Set(
    choices.filter((o) => o.key !== c.key && o.mode === 'existing').map((o) => o.accountId),
  );
  const targets = combineTargets(choices, c.key);
  return (
    <li className="grid gap-3 p-3 md:grid-cols-[auto_1fr_15rem_12rem] md:items-start">
      <Checkbox aria-label={`Select ${c.key}`} isSelected={selected} onChange={onSelect} />
      <div className="min-w-0 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{c.key}</span>
          {c.check.map((r) => (
            <Badge key={r} tone="warning">
              {checkLabel(r, c)}
            </Badge>
          ))}
        </p>
        <p className="text-muted">
          {[
            c.transactions ? `${n(c.transactions)} transactions` : '',
            c.balances ? `${n(c.balances)} days of balances` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
          {c.from && c.to ? (
            <>
              {' · '}
              <DateText value={c.from} /> – <DateText value={c.to} />
            </>
          ) : null}
        </p>
        {c.duplicateOf ? (
          <p className="mt-1 text-muted">
            Same balance as {c.duplicateOf} every day, and no transactions of its own: probably the
            same account connected twice in Monarch, so it’s left out.
          </p>
        ) : null}
        {c.continuedBy ? (
          <p className="mt-1 text-muted">
            {c.continuedBy} picks up {gapText(continuationGap(choices, c))} this one stops:
            combining them keeps one account with the whole history.
          </p>
        ) : null}
        {c.check.includes('type_unsure') ? (
          <p className="mt-1 text-muted">
            The name doesn’t say what it is, and its balances look like a card or a loan.
          </p>
        ) : null}
        {combinedInto(choices, c.key).map((o) => (
          <p key={o.key} className="mt-1 text-muted">
            Also includes {o.key}
            {o.from && o.to ? (
              <>
                {' '}
                (<DateText value={o.from} /> – <DateText value={o.to} />)
              </>
            ) : null}
            .
          </p>
        ))}
        {c.closeOn && c.mode !== 'skip' && c.mode !== 'combine' ? (
          <Checkbox className="mt-1" isSelected={c.close} onChange={(close) => onUpdate({ close })}>
            <span>
              Closed from <DateText value={c.closeOn} />
              {c.lastBalance ? (
                <span className="text-muted">
                  {' '}
                  · last balance <Amount minor={c.lastBalance} currency={currency} kind="balance" />
                </span>
              ) : null}
            </span>
          </Checkbox>
        ) : null}
      </div>
      <Select
        aria-label={`Where ${c.key} goes`}
        value={
          c.mode === 'existing'
            ? c.accountId
            : c.mode === 'combine'
              ? `combine:${c.sameAs}`
              : c.mode
        }
        onChange={(v) => {
          const value = String(v);
          if (value === 'new' || value === 'skip')
            onUpdate({ mode: value, accountId: null, sameAs: null });
          else if (value.startsWith('combine:'))
            onUpdate({ mode: 'combine', accountId: null, sameAs: value.slice('combine:'.length) });
          else onUpdate({ mode: 'existing', accountId: value, sameAs: null });
        }}
      >
        <SelectItem id="new">New account</SelectItem>
        <SelectItem id="skip">Don’t import</SelectItem>
        {accounts.length ? (
          <SelectSection title="Your accounts">
            {accounts
              .filter((a) => !taken.has(a.id))
              .map((a) => (
                <SelectItem key={a.id} id={a.id}>
                  {a.name}
                  {a.closedAt ? ' (closed)' : ''}
                </SelectItem>
              ))}
          </SelectSection>
        ) : null}
        {targets.length ? (
          <SelectSection title="Combine with">
            {targets.map((o) => (
              <SelectItem key={`combine:${o.key}`} id={`combine:${o.key}`}>
                {o.key}
              </SelectItem>
            ))}
          </SelectSection>
        ) : null}
      </Select>
      {c.mode === 'new' ? (
        <Select
          aria-label={`Type of ${c.key}`}
          value={c.type}
          onChange={(v) => onUpdate(withType(c, v as AccountType))}
        >
          {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
            <SelectItem key={t} id={t}>
              {TYPE_LABELS[t]}
            </SelectItem>
          ))}
        </Select>
      ) : (
        <span />
      )}
    </li>
  );
}

// ── 4. Categories ──────────────────────────────────────────────────────────────────────────

function CategoriesStep({
  choices,
  onChange,
  groups,
  source,
  onBack,
  onNext,
}: {
  choices: CategoryChoice[];
  onChange: (c: CategoryChoice[]) => void;
  groups: {
    id: string;
    name: string;
    categories: { id: string; name: string; archived: boolean }[];
  }[];
  source: Source;
  onBack: () => void;
  onNext: () => void;
}) {
  const update = (name: string, patch: Partial<CategoryChoice>) =>
    onChange(choices.map((c) => (c.name === name ? { ...c, ...patch } : c)));
  const created = choices.filter((c) => !c.categoryId).length;
  return (
    <Card className="space-y-5">
      <StepHeading>Match the categories</StepHeading>
      <p className="text-sm text-muted">
        Categories with the same name, or that you matched in an earlier import, are matched
        already. Choose one of yours for the rest (several can go to the same one), or keep it as a
        new category: spending goes in a “From {source === 'monarch' ? 'Monarch' : 'import'}” group,
        income and transfers join your existing groups. You can move them later.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {choices.map((c) => (
          <li
            key={c.name}
            className="grid gap-2 p-3 md:grid-cols-[1fr_16rem_16rem] md:items-center"
          >
            <p className="text-sm">
              <span className="font-medium">{c.name}</span>{' '}
              <span className="text-muted">· {n(c.count)}</span>{' '}
              {c.remembered ? <Badge>As last time</Badge> : null}
            </p>
            <Select
              aria-label={`Category for ${c.name}`}
              value={c.categoryId ?? '__new'}
              onChange={(v) =>
                update(c.name, { categoryId: v === '__new' || v === null ? null : String(v) })
              }
            >
              {[
                <SelectItem key="__new" id="__new">
                  New category
                </SelectItem>,
                ...groups.map((g) => (
                  <SelectSection key={g.id} title={g.name}>
                    {g.categories
                      .filter((x) => !x.archived)
                      .map((x) => (
                        <SelectItem key={x.id} id={x.id}>
                          {x.name}
                        </SelectItem>
                      ))}
                  </SelectSection>
                )),
              ]}
            </Select>
            {c.categoryId ? (
              <span />
            ) : (
              <SegmentedControl
                aria-label={`Kind of ${c.name}`}
                options={KIND_OPTIONS}
                value={
                  (['flexible', 'income', 'transfer'].includes(c.kind) ? c.kind : 'flexible') as
                    'flexible' | 'income' | 'transfer'
                }
                onChange={(kind) => update(c.name, { kind: kind as CategoryKind })}
              />
            )}
          </li>
        ))}
      </ul>
      <StepActions onBack={onBack} onNext={onNext}>
        {n(choices.length - created)} matched, {n(created)} new
      </StepActions>
    </Card>
  );
}

// ── 5. Review ──────────────────────────────────────────────────────────────────────────────

type Filter = 'all' | 'overlap' | 'duplicate' | 'skipped' | 'error';

function ReviewStep({
  householdId,
  choices,
  rows,
  currency,
  includeOverlaps,
  onIncludeOverlaps,
  onBack,
  onNext,
}: {
  householdId: string;
  choices: WizardChoices;
  rows: FileRows;
  currency: string;
  includeOverlaps: Set<number>;
  onIncludeOverlaps: (s: Set<number>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // The preview reads only; it runs once when the step opens.
  useEffect(() => {
    let live = true;
    previewImport(householdId, previewRequest(choices, rows))
      .then((p) => {
        if (!live) return;
        // Rows the browser couldn't read are listed with the server's findings.
        const unread: ImportRowResult[] = rows.problems.map((x) => ({
          line: x.line,
          status: 'error',
          message: x.message,
        }));
        setPreview({
          ...p,
          rows: [...p.rows, ...unread].sort((a, b) => a.line - b.line),
          totals: { ...p.totals, errors: p.totals.errors + unread.length },
        });
      })
      .catch(
        (err: unknown) =>
          live &&
          setError(
            err instanceof ApiError ? `${err.title}. ${err.detail ?? ''}` : 'The preview failed.',
          ),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const byLine = useMemo(() => new Map(rows.transactions.map((t) => [t.line, t])), [rows]);

  if (error) {
    return (
      <Card className="space-y-4">
        <StepHeading>Review</StepHeading>
        <Alert>{error}</Alert>
        <StepActions onBack={onBack} />
      </Card>
    );
  }
  if (!preview) {
    return (
      <Card className="space-y-4">
        <StepHeading>Review</StepHeading>
        <LoadingRegion label="Checking the file">
          <p className="text-sm text-muted">
            Checking {n(rows.transactions.length)} transactions against what’s already here…
          </p>
          <Skeleton className="mt-3 h-24 w-full" />
        </LoadingRegion>
      </Card>
    );
  }

  const listed = preview.rows.filter((r) => filter === 'all' || r.status === filter);
  const totals = { ...preview.totals, new: preview.totals.new + includeOverlaps.size };
  const filters = (
    [
      ['all', 'All', preview.rows.length],
      ['overlap', 'Possible duplicates', preview.totals.overlaps],
      ['duplicate', 'Already imported', preview.totals.duplicates],
      ['skipped', 'Skipped', preview.totals.skipped],
      ['error', 'Problems', preview.totals.errors],
    ] as const
  ).filter(([value, , count]) => value === 'all' || count > 0);

  return (
    <Card className="space-y-5">
      <StepHeading>Review</StepHeading>
      <p className="text-base" role="status">
        {summarize(totals)}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-4 font-medium">Account</th>
              <th className="py-1 pr-4 text-right font-medium">New</th>
              <th className="py-1 pr-4 text-right font-medium">Already imported</th>
              <th className="py-1 pr-4 text-right font-medium">Possible duplicates</th>
              <th className="py-1 pr-4 text-right font-medium">Balances</th>
              <th className="py-1 font-medium">Closed</th>
            </tr>
          </thead>
          <tbody>
            {preview.accounts
              .filter((a) => choices.accounts.find((c) => c.key === a.key)?.mode !== 'skip')
              .map((a) => (
                <tr key={a.key} className="border-t border-border">
                  <td className="py-1 pr-4">
                    {a.name} {a.accountId ? null : <Badge tone="accent">New</Badge>}
                  </td>
                  <td className="py-1 pr-4 text-right tabular-nums">{n(a.new)}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{n(a.duplicates)}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{n(a.overlaps)}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{n(a.balances)}</td>
                  <td className="py-1">{a.closeOn ? <DateText value={a.closeOn} /> : null}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {preview.newCategories.length || preview.newTags.length ? (
        <div className="grid gap-4 text-sm md:grid-cols-2">
          {preview.newCategories.length ? (
            <div>
              <h3 className="font-medium">New categories</h3>
              <p className="text-muted">
                {preview.newCategories.map((c) => `${c.name} (in ${c.group})`).join(', ')}
              </p>
            </div>
          ) : null}
          {preview.newTags.length ? (
            <div>
              <h3 className="font-medium">New tags</h3>
              <p className="text-muted">{preview.newTags.join(', ')}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {preview.rows.length ? (
        <div className="space-y-3">
          <SegmentedControl
            aria-label="Show rows"
            options={filters.map(([value, label, count]) => ({
              value,
              label: value === 'all' ? label : `${label} (${n(count)})`,
            }))}
            value={filter}
            onChange={setFilter}
          />
          <RowList
            rows={listed.slice(0, 300)}
            byLine={byLine}
            currency={currency}
            included={includeOverlaps}
            onToggle={(line, on) => {
              const next = new Set(includeOverlaps);
              if (on) next.add(line);
              else next.delete(line);
              onIncludeOverlaps(next);
            }}
          />
          {listed.length > 300 ? (
            <p className="text-sm text-muted">And {n(listed.length - 300)} more.</p>
          ) : null}
        </div>
      ) : null}

      <StepActions
        onBack={onBack}
        onNext={onNext}
        nextLabel={`Import ${n(totals.new)} ${totals.new === 1 ? 'transaction' : 'transactions'}`}
        nextDisabled={
          totals.new === 0 && preview.accounts.every((a) => a.balances === 0 && !a.closeOn)
        }
      />
    </Card>
  );
}

const STATUS_LABELS: Record<ImportRowResult['status'], string> = {
  new: 'New',
  duplicate: 'Already imported',
  overlap: 'Possible duplicate',
  skipped: 'Skipped',
  error: 'Problem',
};

function RowList({
  rows,
  byLine,
  currency,
  included,
  onToggle,
}: {
  rows: ImportRowResult[];
  byLine: Map<
    number,
    { date: string; amountMinor: number; description: string; name?: string; account: string }
  >;
  currency: string;
  included: Set<number>;
  onToggle: (line: number, on: boolean) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border text-sm">
      {rows.map((r) => {
        const t = byLine.get(r.line);
        return (
          <li key={`${r.line}-${r.status}`} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <Badge
              tone={
                r.status === 'error' ? 'danger' : r.status === 'overlap' ? 'warning' : 'neutral'
              }
            >
              {STATUS_LABELS[r.status]}
            </Badge>
            <span className="min-w-0 flex-1">
              {t ? (
                <>
                  <span className="font-medium">{t.name ?? t.description}</span>{' '}
                  <span className="text-muted">
                    · <DateText value={t.date} /> · {t.account}
                  </span>
                </>
              ) : (
                <span className="text-muted">Line {r.line}</span>
              )}
              {r.message ? <span className="block text-muted">{r.message}</span> : null}
            </span>
            {t ? <Amount minor={t.amountMinor} currency={currency} /> : null}
            {r.status === 'overlap' ? (
              <Checkbox isSelected={included.has(r.line)} onChange={(on) => onToggle(r.line, on)}>
                Import anyway
              </Checkbox>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ── 6. Import ──────────────────────────────────────────────────────────────────────────────

function DoneStep({
  householdId,
  choices,
  rows,
  includeOverlaps,
  onFinished,
}: {
  householdId: string;
  choices: WizardChoices;
  rows: FileRows;
  includeOverlaps: Set<number>;
  onFinished: () => void;
}) {
  const [state, setState] = useState<ImportState | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const ran = useRef(false);

  // Leaving mid-import would stop it partway: ask first.
  useBlocker({
    shouldBlockFn: () =>
      running && !window.confirm('The import is still running. Leave and stop it partway?'),
    enableBeforeUnload: () => running,
  });

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const send = async (from: ImportState) => {
    setRunning(true);
    const next = await sendRows(householdId, from, rows, includeOverlaps, setProgress);
    setState(next);
    setRunning(false);
    onFinished();
  };

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    startImport(householdId, choices, rows)
      .then((run) =>
        send({
          run,
          done: new Set(),
          added: 0,
          balances: 0,
          transfers: 0,
          rows: [],
          failed: null,
        }),
      )
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? `${err.title}. ${err.detail ?? ''}`
            : 'The import couldn’t start.',
        );
        setRunning(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const elapsed = Math.round((now - started) / 1000);
  const keyName = (key: string | null) =>
    key ? (choices.accounts.find((a) => a.key === key)?.name ?? key) : '';

  if (error) {
    return (
      <Card className="space-y-4">
        <StepHeading>Import</StepHeading>
        <Alert>{error} Nothing was imported.</Alert>
      </Card>
    );
  }

  if (running || !state) {
    const p = progress;
    return (
      <Card className="space-y-4">
        <StepHeading>Importing…</StepHeading>
        <ProgressBar
          value={p ? p.rowsDone : 0}
          maxValue={Math.max(p?.rowsTotal ?? 1, 1)}
          {...(p ? {} : { isIndeterminate: true })}
          className="space-y-2"
        >
          {({ percentage }) => (
            <>
              <div className="flex justify-between text-sm">
                <span>
                  {p
                    ? p.current
                      ? `${keyName(p.current)} (${n(p.accountsDone + 1)} of ${n(p.accountsTotal)})`
                      : 'Finishing'
                    : 'Creating accounts and categories'}
                </span>
                <span className="text-muted tabular-nums">
                  {p ? `${n(p.rowsDone)} of ${n(p.rowsTotal)} transactions · ` : ''}
                  {elapsed}s
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${p ? (percentage ?? 0) : 5}%` }}
                />
              </div>
            </>
          )}
        </ProgressBar>
        <p className="text-sm text-muted">
          You can use Fiscus in another tab meanwhile. Keep this page open until it finishes.
        </p>
      </Card>
    );
  }

  const problems = state.rows.filter((r) => r.status === 'error' || r.status === 'skipped');
  const review = rows.transactions.filter(
    (t) => state.done.has(t.account) && t.reviewed !== true,
  ).length;
  return (
    <Card className="space-y-5">
      <StepHeading>
        {undone ? 'Import undone' : state.failed ? 'Import stopped partway' : 'Imported'}
      </StepHeading>
      {undone ? (
        <Alert tone="success">Everything from this import was removed.</Alert>
      ) : (
        <>
          <p className="text-base" role="status">
            {n(state.added)} transactions and {n(state.balances)} balances imported into{' '}
            {n(state.done.size)} {state.done.size === 1 ? 'account' : 'accounts'} in {elapsed}s.
          </p>
          {state.transfers ? (
            <p className="text-sm text-muted">
              {n(state.transfers)} {state.transfers === 1 ? 'transfer' : 'transfers'} between your
              accounts linked, so {state.transfers === 1 ? 'it doesn’t' : 'they don’t'} count as
              spending or income.
            </p>
          ) : null}
          {state.failed ? (
            <Alert>
              {keyName(state.failed.key)} didn’t finish: {state.failed.message}. The accounts before
              it are imported. Retrying sends the rest; anything that already arrived is skipped.
            </Alert>
          ) : null}
          {problems.length ? (
            <p className="text-sm text-muted">
              {n(problems.length)} rows were left out (see the review).
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {state.failed ? (
              <Button onPress={() => void send(state)}>Retry the rest</Button>
            ) : (
              <>
                {review ? (
                  <ButtonLink to="/h/$householdId/review" params={{ householdId }}>
                    Review {n(review)} {review === 1 ? 'transaction' : 'transactions'}
                  </ButtonLink>
                ) : null}
                <ButtonLink
                  to="/h/$householdId/transactions"
                  params={{ householdId }}
                  variant={review ? 'secondary' : 'primary'}
                >
                  Go to transactions
                </ButtonLink>
              </>
            )}
            <Button variant="danger" onPress={() => setConfirmUndo(true)}>
              {state.failed ? 'Undo everything' : 'Undo this import'}
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        isOpen={confirmUndo}
        onOpenChange={setConfirmUndo}
        title="Undo this import?"
        confirmLabel="Undo import"
        destructive
        onConfirm={async () => {
          await undoRun(householdId, state.run.runId);
          setUndone(true);
          onFinished();
        }}
      >
        Removes the {n(state.added)} transactions and {n(state.balances)} balances it added, and the
        accounts it created. Categories and tags it created stay.
      </ConfirmDialog>
      {undone ? (
        <Link
          to="/h/$householdId/accounts"
          params={{ householdId }}
          className="text-sm text-accent-text"
        >
          Back to accounts
        </Link>
      ) : null}
    </Card>
  );
}
