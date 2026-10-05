// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Household } from '@fiscus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { AuthLayout } from '../components/AuthLayout.js';
import {
  Alert,
  Button,
  ComboBox,
  Form,
  RadioCard,
  RadioGroup,
  Select,
  SelectItem,
  TextField,
} from '../components/ui.js';

// Interim first-household screen; the full onboarding flow is #234.

const STYLES = [
  ['hybrid', 'Yours, mine, and ours', 'Some money is shared, some is personal.'],
  ['combined', "It's all ours", 'Everything is shared. No settle-up needed.'],
  ['separate', 'Separate, split shared costs', 'Mostly separate, splitting what you share.'],
  ['roommates', 'Roommates', 'Separate finances, shared bills and rent.'],
] as const;

const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN', 'INR'];
const TIME_ZONES = Intl.supportedValuesOf('timeZone');
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function WelcomePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [style, setStyle] = useState<string>('hybrid');
  const create = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ data: Household }>('POST', '/api/v1/households', { body }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: `/h/${r.data.id}` });
    },
  });
  const err = create.error as ApiError | null;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    create.mutate({
      ...(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>),
      financeStyle: style,
    });
  };

  return (
    <AuthLayout
      title="Create your household"
      subtitle="A household is who you manage money with: just you, a partner, family, or roommates."
    >
      <Form onSubmit={onSubmit} validationErrors={err?.fieldErrors()}>
        {err?.formError ? <Alert>{err.formError}</Alert> : null}
        <TextField
          label="Household name"
          name="name"
          placeholder="Our home"
          isRequired
          maxLength={80}
        />
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <Select label="Currency" name="baseCurrency" defaultValue="USD">
            {COMMON_CURRENCIES.map((c) => (
              <SelectItem key={c} id={c}>
                {c}
              </SelectItem>
            ))}
          </Select>
          <ComboBox
            label="Time zone"
            name="timezone"
            defaultInputValue={deviceZone}
            defaultSelectedKey={deviceZone}
            isRequired
            menuTrigger="focus"
            allowsCustomValue={false}
          >
            {TIME_ZONES.map((z) => (
              <SelectItem key={z} id={z}>
                {z}
              </SelectItem>
            ))}
          </ComboBox>
        </div>
        <RadioGroup
          label="How do you handle money?"
          value={style}
          onChange={setStyle}
          className="gap-2"
        >
          {STYLES.map(([value, label, description]) => (
            <RadioCard key={value} value={value} title={label} description={description} />
          ))}
        </RadioGroup>
        <Button type="submit" className="w-full" isPending={create.isPending}>
          Create household
        </Button>
      </Form>
    </AuthLayout>
  );
}
