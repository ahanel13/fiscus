// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  CategoryGroup,
  HouseholdMember,
  Rule,
  RuleActions,
  RuleConditions,
  RulePreview,
  Tag,
} from '@fiscus/shared';
import { MEMBER_COLORS, TRANSFER_RULE_DEFAULT_DAYS } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  accountsQuery,
  categoriesQuery,
  householdQuery,
  membersQuery,
  preferencesQuery,
  tagsQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { NameCleanupCard } from './name-cleanup.js';
import {
  AmountInput,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DateText,
  Dialog,
  DialogActions,
  Select,
  SelectItem,
  SelectSection,
  SegmentedControl,
  Switch,
  TagPicker,
  TextField,
  toast,
} from '../components/ui.js';
import {
  categoryNames,
  describeActions,
  describeConditions,
  MUTED_KEY,
  type SuggestedRule,
} from '../lib/rules.js';

export { suggestMatchText } from '../lib/rules.js';

// Rules (docs/design/imports.md §3, #41): conditions → actions on transactions as they arrive,
// and on existing ones on request.

type Data<T> = { data: T };
const base = (id: string) => `/api/v1/households/${id}`;
const rulesQuery = (id: string) => ({
  queryKey: ['households', id, 'rules'],
  queryFn: async () => (await api<Data<Rule[]>>('GET', `${base(id)}/rules`)).data,
});

export function RulesPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const tags = useQuery(tagsQuery(householdId)).data ?? [];
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const list = useQuery(rulesQuery(householdId));
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['households', householdId] });
  const canEdit = household.you.role !== 'viewer';
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [applying, setApplying] = useState<Rule | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const names = {
    accounts: new Map(accounts.map((a) => [a.id, a.name])),
    categories: categoryNames(groups),
    tags: new Map(tags.map((t) => [t.id, t.name])),
    members: new Map(members.map((m) => [m.id, m.isYou ? 'me' : m.displayName])),
  };
  const rules = list.data ?? [];

  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api('PUT', `${base(householdId)}/rules/order`, { body: { ids } }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (r: Rule) =>
      api('PATCH', `${base(householdId)}/rules/${r.id}`, { body: { enabled: !r.enabled } }),
    onSuccess: refresh,
  });
  const move = (i: number, by: -1 | 1) => {
    const ids = rules.map((r) => r.id);
    [ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <>
      <PageHeader
        title="Rules"
        showLens={false}
        members={members}
        action={
          canEdit ? (
            <Button onPress={() => setEditing('new')}>
              <Wand2 aria-hidden className="size-4" /> New rule
            </Button>
          ) : undefined
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 md:px-8">
        <p className="text-sm text-muted">
          Rules tidy up transactions as they arrive: rename them, categorize them, tag them, and
          more. They run top to bottom, and a later rule wins when two set the same thing. They
          never change something a person set, and act only where their author could by hand.
        </p>
        {canEdit && household.cleanMerchantNames ? (
          <NameCleanupCard householdId={householdId} />
        ) : null}
        {list.isPending ? null : rules.length === 0 ? (
          <EmptyState icon={Wand2} title="No rules yet">
            <p>Create one here, or from a transaction: open it and choose “Make a rule”.</p>
          </EmptyState>
        ) : (
          <ol className="space-y-2">
            {rules.map((r, i) => (
              <li key={r.id}>
                <Card className="flex flex-wrap items-start gap-3 p-4">
                  <span className="mt-0.5 w-6 text-sm text-muted tabular-nums">{i + 1}.</span>
                  <div className="min-w-0 flex-1 space-y-1 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {r.name ?? describeActions(r.actions, names)}
                      {!r.enabled ? <Badge>Off</Badge> : null}
                      {r.authorLeft ? (
                        <Badge tone="warning">Author left: edit to adopt</Badge>
                      ) : null}
                    </p>
                    <p className="text-muted">
                      When: {describeConditions(r.conditions, names, household.baseCurrency)}
                    </p>
                    {r.name ? (
                      <p className="text-muted">Then: {describeActions(r.actions, names)}</p>
                    ) : null}
                  </div>
                  {canEdit ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <Switch
                        aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} rule ${i + 1}`}
                        isSelected={r.enabled}
                        onChange={() => toggle.mutate(r)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Move rule ${i + 1} up`}
                        isDisabled={i === 0}
                        onPress={() => move(i, -1)}
                      >
                        <ArrowUp aria-hidden className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Move rule ${i + 1} down`}
                        isDisabled={i === rules.length - 1}
                        onPress={() => move(i, 1)}
                      >
                        <ArrowDown aria-hidden className="size-4" />
                      </Button>
                      <Button variant="secondary" size="sm" onPress={() => setApplying(r)}>
                        Apply to existing
                      </Button>
                      <Button variant="ghost" size="sm" onPress={() => setEditing(r)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onPress={() => setDeleting(r)}>
                        Delete
                      </Button>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ol>
        )}
      </div>

      {editing ? (
        <RuleEditor
          householdId={householdId}
          rule={editing === 'new' ? null : editing}
          groups={groups}
          tags={tags}
          members={members}
          accounts={accounts}
          currency={household.baseCurrency}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
      {applying ? (
        <ApplyDialog
          householdId={householdId}
          rule={applying}
          names={names}
          onClose={() => setApplying(null)}
          onApplied={refresh}
        />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this rule?"
        confirmLabel="Delete rule"
        destructive
        onConfirm={async () => {
          await api('DELETE', `${base(householdId)}/rules/${deleting!.id}`);
          await refresh();
          toast('Rule deleted.');
        }}
      >
        Transactions it already changed stay as they are.
      </ConfirmDialog>
    </>
  );
}

// ── Editor ─────────────────────────────────────────────────────────────────────────────────

interface Draft {
  name: string;
  op: 'contains' | 'equals' | 'starts_with';
  text: string;
  direction: 'any' | 'in' | 'out';
  min: number | null;
  max: number | null;
  accountId: string;
  category: string; // 'any' | 'none' | id
  rename: string;
  setCategory: string; // '' | id
  addTagIds: string[];
  forMembers: string[];
  markReviewed: boolean;
  exclude: boolean;
  transferTo: string; // '' | account id
  withinDays: number;
  recordIfMissing: boolean;
}

const ANY = 'any';
const NONE = 'none';

function toDraft(r: {
  name?: string | null;
  conditions: RuleConditions;
  actions: RuleActions;
}): Draft {
  const c = r.conditions;
  const a = r.actions;
  return {
    name: r.name ?? '',
    op: c.description?.op ?? 'contains',
    text: c.description?.value ?? '',
    direction: c.direction ?? 'any',
    min: c.amount?.min ?? null,
    max: c.amount?.max ?? null,
    accountId: c.accountIds?.[0] ?? ANY,
    category: c.categoryId === undefined ? ANY : (c.categoryId ?? 'none'),
    rename: a.rename ?? '',
    setCategory: a.categoryId ?? '',
    addTagIds: a.addTagIds ?? [],
    forMembers: a.attribution?.map((x) => x.memberId) ?? [],
    markReviewed: a.markReviewed ?? false,
    exclude: a.exclude ?? false,
    transferTo: a.transferTo?.accountId ?? '',
    withinDays: a.transferTo?.withinDays ?? TRANSFER_RULE_DEFAULT_DAYS,
    recordIfMissing: a.transferTo?.recordIfMissing ?? false,
  };
}

function fromDraft(d: Draft): { conditions: RuleConditions; actions: RuleActions } {
  const conditions: RuleConditions = {};
  if (d.text.trim()) conditions.description = { op: d.op, value: d.text.trim() };
  if (d.direction !== 'any') conditions.direction = d.direction;
  if (d.min !== null || d.max !== null) {
    conditions.amount = {
      ...(d.min !== null ? { min: Math.abs(d.min) } : {}),
      ...(d.max !== null ? { max: Math.abs(d.max) } : {}),
    };
  }
  if (d.accountId !== ANY) conditions.accountIds = [d.accountId];
  if (d.category !== ANY) conditions.categoryId = d.category === 'none' ? null : d.category;
  const actions: RuleActions = {};
  if (d.rename.trim()) actions.rename = d.rename.trim();
  if (d.setCategory) actions.categoryId = d.setCategory;
  if (d.addTagIds.length) actions.addTagIds = d.addTagIds;
  if (d.forMembers.length) actions.attribution = d.forMembers.map((memberId) => ({ memberId }));
  if (d.markReviewed) actions.markReviewed = true;
  if (d.exclude) actions.exclude = true;
  if (d.transferTo) {
    actions.transferTo = {
      accountId: d.transferTo,
      withinDays: d.withinDays,
      recordIfMissing: d.recordIfMissing,
    };
  }
  return { conditions, actions };
}

export function RuleEditor({
  householdId,
  rule,
  initial,
  groups,
  tags,
  members,
  accounts,
  currency,
  onClose,
  onSaved,
}: {
  householdId: string;
  rule: Rule | null;
  /** A new rule's starting point (from a transaction). */
  initial?: { conditions: RuleConditions; actions: RuleActions };
  groups: CategoryGroup[];
  tags: Tag[];
  members: HouseholdMember[];
  accounts: Pick<Account, 'id' | 'name' | 'yourAccess' | 'balanceMode' | 'closedAt'>[];
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [d, setD] = useState<Draft>(() =>
    toDraft(rule ?? { name: null, ...(initial ?? { conditions: {}, actions: {} }) }),
  );
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const body = fromDraft(d);
  const valid =
    Object.keys(body.conditions).length > 0 &&
    Object.keys(body.actions).length > 0 &&
    (d.min === null || d.max === null || Math.abs(d.min) <= Math.abs(d.max));

  // What it would change, refreshed a moment after you stop editing.
  const key = JSON.stringify(body);
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), 400);
    return () => clearTimeout(t);
  }, [key]);
  const previewQuery = useQuery({
    queryKey: ['households', householdId, 'rules', 'preview', settled],
    queryFn: async () =>
      (
        await api<Data<RulePreview>>('POST', `${base(householdId)}/rules/preview`, {
          body: JSON.parse(settled) as typeof body,
        })
      ).data,
    enabled: valid && settled === key,
  });
  const preview = valid && settled === key ? (previewQuery.data ?? null) : null;

  // Applying it to what it would change now, in the same step (the walkthrough's F18).
  const [applyNow, setApplyNow] = useState(true);
  const willApply = applyNow && (preview?.total ?? 0) > 0;
  const save = useMutation({
    mutationFn: async () => {
      const saved = rule
        ? await api<Data<Rule>>('PATCH', `${base(householdId)}/rules/${rule.id}`, {
            body: { name: d.name.trim() || null, ...body },
          })
        : await api<Data<Rule>>('POST', `${base(householdId)}/rules`, {
            body: { ...(d.name.trim() ? { name: d.name.trim() } : {}), ...body },
          });
      if (!willApply) return null;
      return (
        await api<Data<{ changed: number }>>(
          'POST',
          `${base(householdId)}/rules/${saved.data.id}/apply`,
        )
      ).data.changed;
    },
    onSuccess: (changed) => {
      onSaved();
      toast(rule ? 'Rule saved.' : 'Rule created.', {
        description:
          changed === null
            ? 'It runs on transactions as they arrive. Use “Apply to existing” for the rest.'
            : `Applied to ${changed.toLocaleString('en-US')} existing ${changed === 1 ? 'transaction' : 'transactions'}, and it runs on new ones as they arrive.`,
      });
      onClose();
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });

  const allCategories = groups.map((g) => (
    <SelectSection key={g.id} title={g.name}>
      {g.categories
        .filter((c) => !c.archived)
        .map((c) => (
          <SelectItem key={c.id} id={c.id}>
            {c.name}
          </SelectItem>
        ))}
    </SelectSection>
  ));

  return (
    <Dialog
      title={rule ? 'Edit rule' : 'New rule'}
      size="lg"
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      <div className="space-y-5">
        <TextField
          label="Name (optional)"
          value={d.name}
          onChange={(name) => set({ name })}
          maxLength={80}
          placeholder="Groceries at Trader Joe’s"
        />

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">When a transaction…</legend>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Select
              label="Description"
              value={d.op}
              onChange={(v) => set({ op: v as Draft['op'] })}
            >
              <SelectItem id="contains">contains</SelectItem>
              <SelectItem id="starts_with">starts with</SelectItem>
              <SelectItem id="equals">is exactly</SelectItem>
            </Select>
            <TextField
              label="Text"
              value={d.text}
              onChange={(text) => set({ text })}
              placeholder="TRADER JOE"
              description="Matches the bank’s description or the name, ignoring case."
            />
          </div>
          <SegmentedControl
            aria-label="Money in or out"
            options={[
              { value: 'any', label: 'In or out' },
              { value: 'out', label: 'Money out' },
              { value: 'in', label: 'Money in' },
            ]}
            value={d.direction}
            onChange={(direction) => set({ direction })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <AmountInput
              label="Amount at least"
              currency={currency}
              value={d.min}
              onChange={(min) => set({ min })}
            />
            <AmountInput
              label="Amount at most"
              currency={currency}
              value={d.max}
              onChange={(max) => set({ max })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Account"
              value={d.accountId}
              onChange={(v) => set({ accountId: String(v) })}
            >
              {[
                <SelectItem key={ANY} id={ANY}>
                  Any account
                </SelectItem>,
                ...accounts.map((a) => (
                  <SelectItem key={a.id} id={a.id}>
                    {a.name}
                  </SelectItem>
                )),
              ]}
            </Select>
            <Select
              label="Category now"
              value={d.category}
              onChange={(v) => set({ category: String(v) })}
            >
              <SelectItem id={ANY}>Any category</SelectItem>
              <SelectItem id="none">Uncategorized</SelectItem>
              {allCategories}
            </Select>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">…then</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Rename to"
              value={d.rename}
              onChange={(rename) => set({ rename })}
              maxLength={200}
              placeholder="Trader Joe’s"
            />
            <Select
              label="Set category"
              value={d.setCategory || '__keep'}
              onChange={(v) => set({ setCategory: v === '__keep' ? '' : String(v) })}
            >
              <SelectItem id="__keep">Leave as is</SelectItem>
              {allCategories}
            </Select>
          </div>
          <TagPicker
            label="Add tags"
            tags={tags}
            value={d.addTagIds}
            onChange={(addTagIds) => set({ addTagIds })}
            onCreate={async (name) => {
              const r = await api<Data<Tag>>('POST', `${base(householdId)}/tags`, {
                body: { name, color: MEMBER_COLORS[tags.length % MEMBER_COLORS.length] },
              });
              await queryClient.invalidateQueries({ queryKey: tagsQuery(householdId).queryKey });
              return r.data;
            }}
          />
          {members.length > 1 ? (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Who it’s for</legend>
              <div className="flex flex-wrap gap-x-4">
                {members.map((m) => (
                  <Checkbox
                    key={m.id}
                    isSelected={d.forMembers.includes(m.id)}
                    onChange={(on) =>
                      set({
                        forMembers: on
                          ? [...d.forMembers, m.id]
                          : d.forMembers.filter((x) => x !== m.id),
                      })
                    }
                  >
                    {m.isYou ? 'Me' : m.displayName}
                  </Checkbox>
                ))}
              </div>
              <p className="text-xs text-muted">
                Leave empty to keep the account’s owners. Only on accounts the rule’s author owns.
              </p>
            </fieldset>
          ) : null}
          <TransferAction d={d} set={set} accounts={accounts} />
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Switch isSelected={d.markReviewed} onChange={(markReviewed) => set({ markReviewed })}>
              Mark reviewed
            </Switch>
            <Switch isSelected={d.exclude} onChange={(exclude) => set({ exclude })}>
              Exclude from reports and budgets
            </Switch>
          </div>
        </fieldset>

        <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm" role="status">
          {!valid ? (
            <span className="text-muted">Add at least one condition and one action.</span>
          ) : preview === null ? (
            <span className="text-muted">Checking your transactions…</span>
          ) : (
            <>
              <p>
                {preview.total === 0
                  ? 'Matches nothing it would change among the transactions you can see.'
                  : `Would change ${preview.total.toLocaleString('en-US')} ${
                      preview.total === 1 ? 'transaction' : 'transactions'
                    } you can see, if applied to existing ones.`}
              </p>
              {preview.total > 0 ? (
                <Checkbox isSelected={applyNow} onChange={setApplyNow} className="mt-2">
                  Apply it to {preview.total === 1 ? 'that one' : 'those'} now too
                </Checkbox>
              ) : null}
              {preview.changes.length ? (
                <ul className="mt-2 space-y-1 text-muted">
                  {preview.changes.slice(0, 5).map((c) => (
                    <li key={c.transactionId} className="flex gap-2">
                      <DateText value={c.date} />
                      <span className="min-w-0 flex-1 truncate">{c.displayName}</span>
                      <Amount minor={c.amountMinor} currency={c.currency} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        {rule ? (
          <p className="text-xs text-muted">
            Saving makes you this rule’s author: it will act with your access to accounts.
          </p>
        ) : null}
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isDisabled={!valid} isPending={save.isPending} onPress={() => save.mutate()}>
            {rule ? 'Save rule' : 'Create rule'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

const WITHIN_DAYS = [3, 5, 7, 10, 14, 21, 30];

/**
 * "Transfer to an account" (transfers.md §3): link to the other side there within some days,
 * wait for it meanwhile, or record it when it's a manual account that follows its transactions.
 */
function TransferAction({
  d,
  set,
  accounts,
}: {
  d: Draft;
  set: (patch: Partial<Draft>) => void;
  accounts: Pick<Account, 'id' | 'name' | 'yourAccess' | 'balanceMode' | 'closedAt'>[];
}) {
  const owned = accounts.filter(
    (a) => a.yourAccess === 'owner' && (!a.closedAt || a.id === d.transferTo),
  );
  const target = owned.find((a) => a.id === d.transferTo);
  const canRecord = target?.balanceMode === 'transactions';
  if (owned.length < 2 && !target) return null;
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium">Transfer</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Transfer to"
          value={d.transferTo || NONE}
          onChange={(v) => {
            const id = v && v !== NONE ? String(v) : '';
            const next = owned.find((a) => a.id === id);
            set({
              transferTo: id,
              recordIfMissing: d.recordIfMissing && next?.balanceMode === 'transactions',
            });
          }}
        >
          <SelectItem id={NONE}>Not a transfer</SelectItem>
          {owned.map((a) => (
            <SelectItem key={a.id} id={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </Select>
        {target ? (
          <Select
            label="Look for the other side within"
            value={String(d.withinDays)}
            onChange={(v) => v && set({ withinDays: Number(v) })}
          >
            {[...new Set([...WITHIN_DAYS, d.withinDays])]
              .sort((x, y) => x - y)
              .map((n) => (
                <SelectItem key={n} id={String(n)}>
                  {n} days
                </SelectItem>
              ))}
          </Select>
        ) : null}
      </div>
      {target ? (
        <>
          <p className="text-xs text-muted">
            Links it to the same amount arriving in {target.name} up to {d.withinDays} days before
            or after. Until that arrives it waits, counted as a transfer, not spending.
          </p>
          <Checkbox
            isSelected={d.recordIfMissing}
            isDisabled={!canRecord}
            onChange={(recordIfMissing) => set({ recordIfMissing })}
          >
            If it isn’t there, record it in {target.name}
          </Checkbox>
          <p className="text-xs text-muted">
            {canRecord
              ? 'For an account your bank feed doesn’t cover: its balance follows. Only for transactions as they arrive, not when applying to existing ones.'
              : `${target.name}’s balance is entered by hand, so a transaction recorded there wouldn’t change it.`}
          </p>
        </>
      ) : null}
    </fieldset>
  );
}

// ── Apply to existing ──────────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  displayName: 'name',
  categoryId: 'category',
  tagIds: 'tags',
  attribution: 'who it’s for',
  reviewStatus: 'reviewed',
  excluded: 'excluded',
};

const TRANSFER_OUTCOMES = {
  link: 'linked to its other side',
  record: 'other side recorded',
  wait: 'waits for its other side',
} as const;

function ApplyDialog({
  householdId,
  rule,
  names,
  onClose,
  onApplied,
}: {
  householdId: string;
  rule: Rule;
  names: { categories: Map<string, string> };
  onClose: () => void;
  onApplied: () => void;
}) {
  const preview = useQuery({
    queryKey: ['households', householdId, 'rules', rule.id, 'preview', rule.version],
    queryFn: async () =>
      (
        await api<Data<RulePreview>>('POST', `${base(householdId)}/rules/preview`, {
          body: { conditions: rule.conditions, actions: rule.actions },
        })
      ).data,
  });
  const apply = useMutation({
    mutationFn: () =>
      api<Data<{ changed: number }>>('POST', `${base(householdId)}/rules/${rule.id}/apply`),
    onSuccess: (r) => {
      onApplied();
      toast(`${r.data.changed.toLocaleString('en-US')} changed.`);
      onClose();
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const p = preview.data;
  const rows = useMemo(() => p?.changes.slice(0, 50) ?? [], [p]);
  return (
    <Dialog
      title="Apply to existing transactions"
      size="lg"
      isOpen
      onOpenChange={(o) => !o && onClose()}
    >
      <div className="space-y-4">
        {!p ? (
          <p className="text-sm text-muted" role="status">
            Checking your transactions…
          </p>
        ) : p.total === 0 ? (
          <p className="text-sm" role="status">
            Nothing to change: transactions this rule matches are already like this, were set by a
            person, or are outside its reach.
          </p>
        ) : (
          <>
            <p className="text-sm" role="status">
              {p.total.toLocaleString('en-US')} {p.total === 1 ? 'transaction' : 'transactions'}{' '}
              would change. Anything a person set stays as it is.
            </p>
            <ul className="max-h-80 divide-y divide-border overflow-auto rounded-lg border border-border text-sm">
              {rows.map((c) => (
                <li key={c.transactionId} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
                  <DateText value={c.date} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate">{c.displayName}</span>
                  <Amount minor={c.amountMinor} currency={c.currency} />
                  <span className="w-full text-xs text-muted">
                    {Object.keys(c.changes)
                      .map((f) =>
                        f === 'categoryId' && c.changes.categoryId
                          ? `category → ${names.categories.get(c.changes.categoryId[1]) ?? '…'}`
                          : f === 'displayName' && c.changes.displayName
                            ? `name → “${c.changes.displayName[1]}”`
                            : f === 'transfer' && c.changes.transfer
                              ? TRANSFER_OUTCOMES[c.changes.transfer[1].outcome]
                              : FIELD_LABELS[f],
                      )
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
            {p.total > rows.length ? (
              <p className="text-xs text-muted">
                And {(p.total - rows.length).toLocaleString('en-US')} more.
              </p>
            ) : null}
          </>
        )}
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            isDisabled={!p || p.total === 0}
            isPending={apply.isPending}
            onPress={() => apply.mutate()}
          >
            Apply
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

// ── Suggestions ────────────────────────────────────────────────────────────────────────────

/** Rules and the descriptions you muted, for deciding whether to suggest one. */
export function useRuleSuggestionContext(householdId: string) {
  const rules = useQuery(rulesQuery(householdId)).data ?? [];
  const prefs = useQuery(preferencesQuery(householdId)).data ?? {};
  const muted = Array.isArray(prefs[MUTED_KEY]) ? (prefs[MUTED_KEY] as string[]) : [];
  return { rules, muted };
}

/**
 * "Make this a rule?" after you rename or recategorize: create it (and apply it to the others it
 * matches), edit it first, or stop suggesting it for that description.
 */
export function RuleSuggestion({
  householdId,
  suggestion,
  groups,
  members,
  onDone,
}: {
  householdId: string;
  suggestion: SuggestedRule;
  groups: CategoryGroup[];
  members: HouseholdMember[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const household = useQuery(householdQuery(householdId)).data;
  const tags = useQuery(tagsQuery(householdId)).data ?? [];
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const { muted } = useRuleSuggestionContext(householdId);
  const [applyToOthers, setApplyToOthers] = useState(true);
  const [editing, setEditing] = useState(false);
  const body = { conditions: suggestion.conditions, actions: suggestion.actions };
  const preview = useQuery({
    queryKey: ['households', householdId, 'rules', 'preview', JSON.stringify(body)],
    queryFn: async () =>
      (await api<Data<RulePreview>>('POST', `${base(householdId)}/rules/preview`, { body })).data,
  });
  const others = preview.data?.total ?? 0;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['households', householdId] });
  const create = useMutation({
    mutationFn: async () => {
      const r = await api<Data<Rule>>('POST', `${base(householdId)}/rules`, { body });
      if (!applyToOthers || others === 0) return 0;
      return (
        await api<Data<{ changed: number }>>(
          'POST',
          `${base(householdId)}/rules/${r.data.id}/apply`,
        )
      ).data.changed;
    },
    onSuccess: async (changed) => {
      await refresh();
      toast('Rule created.', {
        ...(changed
          ? { description: `${changed.toLocaleString('en-US')} other transactions changed too.` }
          : {}),
      });
      onDone();
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const mute = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/preferences/${MUTED_KEY}`, {
        body: { value: [...muted, suggestion.matchText].slice(-50) },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: preferencesQuery(householdId).queryKey });
      onDone();
    },
  });
  const names = {
    categories: categoryNames(groups),
    tags: new Map(tags.map((t) => [t.id, t.name])),
    members: new Map(members.map((m) => [m.id, m.displayName])),
  };

  return (
    <div
      role="region"
      aria-label="Rule suggestion"
      className="space-y-3 rounded-lg border border-accent/40 bg-accent-soft p-3 text-sm"
    >
      <p className="flex items-start gap-2">
        <Wand2 aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
        <span>
          <span className="font-medium">Make this a rule?</span> When the description contains “
          {suggestion.matchText}”: {describeActions(suggestion.actions, names)}.
        </span>
      </p>
      {others > 0 ? (
        <Checkbox isSelected={applyToOthers} onChange={setApplyToOthers}>
          Also change the {others.toLocaleString('en-US')} other{' '}
          {others === 1 ? 'transaction' : 'transactions'} it matches
        </Checkbox>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" isPending={create.isPending} onPress={() => create.mutate()}>
          Create rule
        </Button>
        <Button size="sm" variant="secondary" onPress={() => setEditing(true)}>
          Edit first
        </Button>
        <Button size="sm" variant="ghost" onPress={onDone}>
          Not now
        </Button>
        <Button size="sm" variant="ghost" isPending={mute.isPending} onPress={() => mute.mutate()}>
          Don’t suggest for “{suggestion.matchText}”
        </Button>
      </div>
      {editing ? (
        <RuleEditor
          householdId={householdId}
          rule={null}
          initial={body}
          groups={groups}
          tags={tags}
          members={members}
          accounts={accounts}
          currency={household?.baseCurrency ?? 'USD'}
          onClose={() => setEditing(false)}
          onSaved={() => {
            void refresh();
            onDone();
          }}
        />
      ) : null}
    </div>
  );
}
