import type { CurrentUser } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { authStatusQuery, lookupInvite, meQuery } from '../api/queries.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { Alert, Button, Field, Input } from '../components/ui.js';

type SignedIn = { data: { user: CurrentUser; csrfToken: string } };

const fragmentToken = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
const formValues = (e: FormEvent<HTMLFormElement>) =>
  Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

function useSignedIn(redirect?: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    await navigate({ to: redirect && redirect.startsWith('/') ? redirect : '/' });
  };
}

export function LoginPage() {
  const { redirect } = useSearch({ strict: false }) as { redirect?: string };
  const status = useQuery(authStatusQuery);
  const navigate = useNavigate();
  const done = useSignedIn(redirect);
  const login = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<SignedIn>('POST', '/api/v1/auth/login', { body }),
    onSuccess: done,
  });

  useEffect(() => {
    if (status.data?.setupRequired) void navigate({ to: '/setup' });
  }, [status.data, navigate]);

  return (
    <AuthLayout title="Sign in">
      <form
        className="space-y-4"
        onSubmit={(e) => (e.preventDefault(), login.mutate(formValues(e)))}
      >
        {login.error ? <Alert>{(login.error as ApiError).title}</Alert> : null}
        <Field label="Email">
          {(p) => <Input {...p} name="email" type="email" autoComplete="email" required />}
        </Field>
        <Field label="Password">
          {(p) => (
            <Input
              {...p}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          )}
        </Field>
        <Button type="submit" className="w-full" busy={login.isPending}>
          Sign in
        </Button>
      </form>
      {status.data?.signupMode === 'open' ? (
        <p className="mt-4 text-center text-sm text-muted">
          New here?{' '}
          <Link to="/signup" className="font-medium text-accent">
            Create an account
          </Link>
        </p>
      ) : null}
    </AuthLayout>
  );
}

export function SignupPage() {
  const done = useSignedIn();
  const signup = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<SignedIn>('POST', '/api/v1/auth/signup', { body }),
    onSuccess: done,
  });
  const err = signup.error as ApiError | null;
  return (
    <AuthLayout title="Create your account">
      <form
        className="space-y-4"
        onSubmit={(e) => (e.preventDefault(), signup.mutate(formValues(e)))}
      >
        {err && err.errors.length === 0 ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <Field label="Your name" error={err?.fieldError('displayName')}>
          {(p) => <Input {...p} name="displayName" autoComplete="name" required />}
        </Field>
        <Field label="Email" error={err?.fieldError('email')}>
          {(p) => <Input {...p} name="email" type="email" autoComplete="email" required />}
        </Field>
        <Field label="Password" error={err?.fieldError('password')} hint="At least 12 characters.">
          {(p) => (
            <Input
              {...p}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
            />
          )}
        </Field>
        <Button type="submit" className="w-full" busy={signup.isPending}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

export function SetupPage() {
  const done = useSignedIn('/welcome');
  const setup = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<SignedIn>('POST', '/api/v1/auth/setup', { body }),
    onSuccess: done,
  });
  const err = setup.error as ApiError | null;
  return (
    <AuthLayout
      title="Set up Fiscus"
      subtitle={
        <>
          Create the first account. It becomes the instance admin. Find the one-time setup token in
          the server logs:{' '}
          <code className="rounded bg-surface-2 px-1">
            docker compose logs api | grep "setup token"
          </code>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => (e.preventDefault(), setup.mutate(formValues(e)))}
      >
        {err && err.errors.length === 0 ? <Alert>{err.title}</Alert> : null}
        <Field label="Setup token" error={err?.fieldError('setupToken')}>
          {(p) => <Input {...p} name="setupToken" autoComplete="off" required spellCheck={false} />}
        </Field>
        <Field label="Your name" error={err?.fieldError('displayName')}>
          {(p) => <Input {...p} name="displayName" autoComplete="name" required />}
        </Field>
        <Field label="Email" error={err?.fieldError('email')}>
          {(p) => <Input {...p} name="email" type="email" autoComplete="email" required />}
        </Field>
        <Field label="Password" error={err?.fieldError('password')} hint="At least 12 characters.">
          {(p) => (
            <Input
              {...p}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
            />
          )}
        </Field>
        <Button type="submit" className="w-full" busy={setup.isPending}>
          Create admin account
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Invite links carry the token in the fragment, so it never reaches server logs. */
export function InvitePage() {
  const [token] = useState(fragmentToken);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => lookupInvite(token),
    enabled: !!token,
    retry: false,
  });
  const me = useQuery({ ...meQuery, retry: false });
  const joined = async (householdId: string) => {
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    await navigate({ to: `/h/${householdId}` });
  };
  const accept = useMutation({
    mutationFn: () =>
      api<{ data: { householdId: string } }>('POST', '/api/v1/invites/accept', { body: { token } }),
    onSuccess: (r) => joined(r.data.householdId),
  });
  const signup = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<SignedIn>('POST', '/api/v1/invites/signup', { body: { ...body, token } }),
    onSuccess: async () => {
      const fresh = await queryClient.fetchQuery(meQuery);
      await joined(fresh.memberships.at(-1)?.householdId ?? '');
    },
  });

  if (!token || preview.error) {
    return (
      <AuthLayout title="Invite not valid">
        <p className="text-sm text-muted">
          This invite link is invalid, used, or expired. Ask for a new one.
        </p>
      </AuthLayout>
    );
  }
  if (!preview.data) return <AuthLayout title="Loading invite…">{null}</AuthLayout>;
  const invite = preview.data;
  const err = (accept.error ?? signup.error) as ApiError | null;
  const back = `/invite#token=${token}`;

  return (
    <AuthLayout
      title={`Join ${invite.householdName}`}
      subtitle={`${invite.invitedBy ?? 'A household owner'} invited ${invite.email} as ${invite.role === 'owner' ? 'a co-owner' : `a ${invite.role}`}.`}
    >
      {err && err.errors.length === 0 ? <Alert>{err.detail ?? err.title}</Alert> : null}
      {me.data ? (
        me.data.email === invite.email ? (
          <Button className="w-full" busy={accept.isPending} onClick={() => accept.mutate()}>
            Accept and join
          </Button>
        ) : (
          <p className="text-sm text-muted">
            You're signed in as {me.data.email}. Sign out and sign in as {invite.email} to accept.
          </p>
        )
      ) : invite.accountExists ? (
        <Link to="/login" search={{ redirect: back }} className="block">
          <Button className="w-full">Sign in as {invite.email}</Button>
        </Link>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => (e.preventDefault(), signup.mutate(formValues(e)))}
        >
          <Field label="Email">
            {(p) => <Input {...p} value={invite.email} disabled readOnly />}
          </Field>
          <Field label="Your name" error={err?.fieldError('displayName')}>
            {(p) => <Input {...p} name="displayName" autoComplete="name" required />}
          </Field>
          <Field
            label="Password"
            error={err?.fieldError('password')}
            hint="At least 12 characters."
          >
            {(p) => (
              <Input
                {...p}
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
              />
            )}
          </Field>
          <Button type="submit" className="w-full" busy={signup.isPending}>
            Create account and join
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [token] = useState(fragmentToken);
  const reset = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api('POST', '/api/v1/auth/password-reset', { body: { ...body, token } }),
  });
  const err = reset.error as ApiError | null;
  return (
    <AuthLayout title="Choose a new password">
      {reset.isSuccess ? (
        <div className="space-y-4">
          <Alert tone="success">Password changed. You've been signed out everywhere.</Alert>
          <Link to="/login" className="block">
            <Button className="w-full">Sign in</Button>
          </Link>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => (e.preventDefault(), reset.mutate(formValues(e)))}
        >
          {err && err.errors.length === 0 ? <Alert>{err.title}</Alert> : null}
          <Field
            label="New password"
            error={err?.fieldError('password')}
            hint="At least 12 characters."
          >
            {(p) => (
              <Input
                {...p}
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
              />
            )}
          </Field>
          <Button type="submit" className="w-full" busy={reset.isPending} disabled={!token}>
            Set password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
