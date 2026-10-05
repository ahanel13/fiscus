// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CurrentUser } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { authStatusQuery, lookupInvite, meQuery } from '../api/queries.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { Alert, Button, ButtonLink, Form, TextField } from '../components/ui.js';

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
      <Form onSubmit={(e) => (e.preventDefault(), login.mutate(formValues(e)))}>
        {login.error ? <Alert>{(login.error as ApiError).title}</Alert> : null}
        <TextField label="Email" name="email" type="email" autoComplete="email" isRequired />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          isRequired
        />
        <Button type="submit" className="w-full" isPending={login.isPending}>
          Sign in
        </Button>
      </Form>
      {status.data?.signupMode === 'open' ? (
        <p className="mt-4 text-center text-sm text-muted">
          New here?{' '}
          <Link to="/signup" className="font-medium text-accent-text">
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
      <Form
        onSubmit={(e) => (e.preventDefault(), signup.mutate(formValues(e)))}
        validationErrors={err?.fieldErrors()}
      >
        {err?.formError ? <Alert>{err.formError}</Alert> : null}
        <TextField label="Your name" name="displayName" autoComplete="name" isRequired />
        <TextField label="Email" name="email" type="email" autoComplete="email" isRequired />
        <TextField
          label="Password"
          description="At least 12 characters."
          name="password"
          type="password"
          autoComplete="new-password"
          isRequired
          minLength={12}
        />
        <Button type="submit" className="w-full" isPending={signup.isPending}>
          Create account
        </Button>
      </Form>
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
      <Form
        onSubmit={(e) => (e.preventDefault(), setup.mutate(formValues(e)))}
        validationErrors={err?.fieldErrors()}
      >
        {err?.formError ? <Alert>{err.formError}</Alert> : null}
        <TextField
          label="Setup token"
          name="setupToken"
          autoComplete="off"
          isRequired
          inputClassName="font-mono"
        />
        <TextField label="Your name" name="displayName" autoComplete="name" isRequired />
        <TextField label="Email" name="email" type="email" autoComplete="email" isRequired />
        <TextField
          label="Password"
          description="At least 12 characters."
          name="password"
          type="password"
          autoComplete="new-password"
          isRequired
          minLength={12}
        />
        <Button type="submit" className="w-full" isPending={setup.isPending}>
          Create admin account
        </Button>
      </Form>
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
      {err?.formError ? <Alert>{err.formError}</Alert> : null}
      {me.data ? (
        me.data.email === invite.email ? (
          <Button className="w-full" isPending={accept.isPending} onPress={() => accept.mutate()}>
            Accept and join
          </Button>
        ) : (
          <p className="text-sm text-muted">
            You're signed in as {me.data.email}. Sign out and sign in as {invite.email} to accept.
          </p>
        )
      ) : invite.accountExists ? (
        <ButtonLink to="/login" search={{ redirect: back }} className="w-full">
          Sign in as {invite.email}
        </ButtonLink>
      ) : (
        <Form
          onSubmit={(e) => (e.preventDefault(), signup.mutate(formValues(e)))}
          validationErrors={err?.fieldErrors()}
        >
          <TextField label="Email" value={invite.email} isDisabled isReadOnly />
          <TextField label="Your name" name="displayName" autoComplete="name" isRequired />
          <TextField
            label="Password"
            description="At least 12 characters."
            name="password"
            type="password"
            autoComplete="new-password"
            isRequired
            minLength={12}
          />
          <Button type="submit" className="w-full" isPending={signup.isPending}>
            Create account and join
          </Button>
        </Form>
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
          <ButtonLink to="/login" className="w-full">
            Sign in
          </ButtonLink>
        </div>
      ) : (
        <Form
          onSubmit={(e) => (e.preventDefault(), reset.mutate(formValues(e)))}
          validationErrors={err?.fieldErrors()}
        >
          {err?.formError ? <Alert>{err.formError}</Alert> : null}
          <TextField
            label="New password"
            description="At least 12 characters."
            name="password"
            type="password"
            autoComplete="new-password"
            isRequired
            minLength={12}
          />
          <Button type="submit" className="w-full" isPending={reset.isPending} isDisabled={!token}>
            Set password
          </Button>
        </Form>
      )}
    </AuthLayout>
  );
}
