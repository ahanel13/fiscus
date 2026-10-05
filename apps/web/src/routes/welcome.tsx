import type { Household } from '@fiscus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';

// Interim first-household screen; the full onboarding flow is #234.

const STYLES = [
  ['hybrid', 'Yours, mine, and ours', 'Some money is shared, some is personal.'],
  ['combined', "It's all ours", 'Everything is shared. No settle-up needed.'],
  ['separate', 'Separate, split shared costs', 'Mostly separate, splitting what you share.'],
  ['roommates', 'Roommates', 'Separate finances, shared bills and rent.'],
] as const;

const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN', 'INR'];

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
      <form className="space-y-4" onSubmit={onSubmit}>
        {err && err.errors.length === 0 ? <Alert>{err.title}</Alert> : null}
        <Field label="Household name" error={err?.fieldError('name')}>
          {(p) => <Input {...p} name="name" placeholder="Our home" required maxLength={80} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Currency" error={err?.fieldError('baseCurrency')}>
            {(p) => (
              <Select {...p} name="baseCurrency" defaultValue="USD">
                {COMMON_CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Time zone" error={err?.fieldError('timezone')}>
            {(p) => (
              <Input
                {...p}
                name="timezone"
                defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
                required
              />
            )}
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">How do you handle money?</legend>
          {STYLES.map(([value, label, description]) => (
            <label
              key={value}
              className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent"
            >
              <input
                type="radio"
                name="style"
                value={value}
                checked={style === value}
                onChange={() => setStyle(value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-sm text-muted">{description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button type="submit" className="w-full" busy={create.isPending}>
          Create household
        </Button>
      </form>
    </AuthLayout>
  );
}
