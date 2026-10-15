// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Household } from '@fiscus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  Alert,
  Button,
  Card,
  ComboBox,
  Form,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Switch,
  TextField,
  toast,
} from '../components/ui.js';

// The browser's list leaves out plain "UTC", which is a valid household time zone.
const TIME_ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, i, 1)),
  ),
);
const STYLES: [Household['financeStyle'], string][] = [
  ['hybrid', 'Yours, mine, and ours'],
  ['combined', 'It’s all ours'],
  ['separate', 'Separate, split shared costs'],
  ['roommates', 'Roommates'],
];

/**
 * The household's name and time settings (HH-01/02, ADR 0011 §4, #69). Owners edit; everyone
 * else sees them. Changing them re-dates every view at once: ranges, quarters, and YTD follow.
 */
export function HouseholdGeneral({
  household,
  memberCount,
}: {
  household: Household;
  memberCount: number;
}) {
  const owner = household.you.role === 'owner';
  const queryClient = useQueryClient();
  const initial = {
    name: household.name,
    timezone: household.timezone,
    weekStart: household.weekStart,
    fiscalYearStartMonth: household.fiscalYearStartMonth,
    dateBasis: household.dateBasis,
    financeStyle: household.financeStyle,
    categorizeMarksReviewed: household.categorizeMarksReviewed,
    cleanMerchantNames: household.cleanMerchantNames,
  };
  const [form, setForm] = useState(initial);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const changes = Object.fromEntries(
    Object.entries(form).filter(([k, v]) => v !== initial[k as keyof typeof initial]),
  );
  const save = useMutation({
    mutationFn: () =>
      api('PATCH', `/api/v1/households/${household.id}`, {
        body: changes,
        headers: { 'if-match': `"v${household.version}"` },
      }),
    onSuccess: async () => {
      // Every range, quarter, and date depends on these.
      await queryClient.invalidateQueries({ queryKey: ['households', household.id] });
      toast('Household settings saved.');
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const err = save.error as ApiError | null;

  return (
    <Card>
      <h2 className="mb-4 font-semibold">General</h2>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        validationErrors={err?.fieldErrors()}
      >
        {err?.formError && err.code !== 'edit_conflict' ? <Alert>{err.formError}</Alert> : null}
        <TextField
          label="Name"
          name="name"
          value={form.name}
          onChange={(name) => set({ name })}
          isReadOnly={!owner}
          isRequired
          maxLength={80}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <ComboBox
            label="Time zone"
            selectedKey={form.timezone}
            onSelectionChange={(k) => k && set({ timezone: String(k) })}
            isDisabled={!owner}
            menuTrigger="focus"
            description="“Today”, and every range, follow this zone for everyone in the household."
          >
            {TIME_ZONES.map((z) => (
              <SelectItem key={z} id={z}>
                {z}
              </SelectItem>
            ))}
          </ComboBox>
          <TextField
            label="Currency"
            value={household.baseCurrency}
            isReadOnly
            description="Set when the household was created."
          />
          <Select
            label="Weeks start on"
            value={String(form.weekStart)}
            onChange={(v) => v !== null && set({ weekStart: Number(v) })}
            isDisabled={!owner}
          >
            {WEEKDAYS.map((d, i) => (
              <SelectItem key={d} id={String(i)}>
                {d}
              </SelectItem>
            ))}
          </Select>
          <Select
            label="Fiscal year starts in"
            value={String(form.fiscalYearStartMonth)}
            onChange={(v) => v !== null && set({ fiscalYearStartMonth: Number(v) })}
            isDisabled={!owner}
            description="Quarters and year to date follow it."
          >
            {MONTHS.map((m, i) => (
              <SelectItem key={m} id={String(i + 1)}>
                {m}
              </SelectItem>
            ))}
          </Select>
        </div>
        <RadioGroup
          label="Date transactions by"
          value={form.dateBasis}
          onChange={(v) => set({ dateBasis: v as Household['dateBasis'] })}
          isDisabled={!owner}
          description="Applies to every view: lists, budgets, and reports."
        >
          <Radio value="posted">The day they cleared (the bank’s posted date)</Radio>
          <Radio value="authorized">The day you bought something (the authorized date)</Radio>
        </RadioGroup>
        {memberCount > 1 ? (
          <Select
            label="How you handle money together"
            value={form.financeStyle}
            onChange={(v) => v && set({ financeStyle: v as Household['financeStyle'] })}
            isDisabled={!owner}
            description="Sets defaults for new accounts and which screens show. Existing accounts don’t change."
          >
            {STYLES.map(([value, label]) => (
              <SelectItem key={value} id={value}>
                {label}
              </SelectItem>
            ))}
          </Select>
        ) : null}
        <div className="space-y-1">
          <Switch
            isSelected={form.categorizeMarksReviewed}
            onChange={(categorizeMarksReviewed) => set({ categorizeMarksReviewed })}
            isDisabled={!owner}
          >
            Setting a category marks a transaction reviewed
          </Switch>
          <p className="text-xs text-muted">
            Choosing the category is usually the review. Turn this off to review separately.
          </p>
        </div>
        <div className="space-y-1">
          <Switch
            isSelected={form.cleanMerchantNames}
            onChange={(cleanMerchantNames) => set({ cleanMerchantNames })}
            isDisabled={!owner}
          >
            Clean up merchant names
          </Switch>
          <p className="text-xs text-muted">
            “SQ *BLUE BOTTLE #12” becomes “Blue Bottle” when a bank file is imported. The bank’s
            text is always kept as the original. Turn this off to name transactions with it as is.
          </p>
        </div>
        {owner ? (
          <div className="flex justify-end">
            <Button
              type="submit"
              isPending={save.isPending}
              isDisabled={Object.keys(changes).length === 0}
            >
              Save changes
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">Only household owners can change these.</p>
        )}
      </Form>
    </Card>
  );
}
