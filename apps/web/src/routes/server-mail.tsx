// SPDX-License-Identifier: AGPL-3.0-or-later
import { describeChannelError, type MailSecurity, type MailStatus } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { mailStatusQuery } from '../api/queries.js';
import { ReauthCancelled, useRecentAuth } from '../components/RecentAuth.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  Form,
  Select,
  SelectItem,
  Skeleton,
  TextField,
  toast,
} from '../components/ui.js';

// Server → Email (bills walkthrough D16, #125): the mail server notification email goes out
// through. Set here, or by SMTP_URL and MAIL_FROM, which win and are shown read-only. The password
// is write-only: never shown, and kept when left blank.

type Data<T> = { data: T };

const SECURITY: { id: MailSecurity; label: string; port: number }[] = [
  { id: 'starttls', label: 'STARTTLS', port: 587 },
  { id: 'tls', label: 'TLS', port: 465 },
  { id: 'none', label: 'None', port: 25 },
];
const securityLabel = (s: MailSecurity | null) => SECURITY.find((x) => x.id === s)?.label ?? '';

const failed = (e: unknown) => {
  if (e instanceof ReauthCancelled) return;
  const err = e as ApiError;
  toast(err.formError ?? err.title, { tone: 'error' });
};

export function MailSection({ email }: { email: string }) {
  const status = useQuery(mailStatusQuery);
  const [editing, setEditing] = useState(false);
  const test = useMutation({
    mutationFn: () => api('POST', '/api/v1/admin/mail/test'),
    onSuccess: () => toast(`Test email sent to ${email}.`),
    onError: (e) => {
      const err = e as ApiError;
      toast(
        err.code === 'mail_failed'
          ? `The test email didn’t go through. ${describeChannelError(err.detail ?? null)}`
          : err.title,
        { tone: 'error' },
      );
    },
  });
  const s = status.data;
  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">Email</h2>
        {s?.source === 'environment' ? <Badge>Set by your server’s environment</Badge> : null}
      </div>
      {status.isPending || !s ? (
        <Skeleton className="h-10" />
      ) : editing ? null : s.configured ? (
        <>
          <p className="mb-3 text-sm text-muted">
            Notification email goes out from {s.from}, to those who choose it in their notification
            settings.
          </p>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Mail server</dt>
            <dd>
              {s.host}:{s.port} · {securityLabel(s.security)}
            </dd>
            <dt className="text-muted">Signs in as</dt>
            <dd>{s.username ?? 'No sign-in'}</dd>
            <dt className="text-muted">From</dt>
            <dd>{s.from}</dd>
          </dl>
          {s.passwordUnreadable ? (
            <Alert tone="warning">
              The saved password can’t be read any more (the server’s key changed). Enter it again.
            </Alert>
          ) : null}
          {s.source === 'environment' ? (
            <p className="mb-4 text-sm text-muted">
              SMTP_URL and MAIL_FROM set these, and win over this page. Change them where Fiscus
              runs.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" isPending={test.isPending} onPress={() => test.mutate()}>
              Send a test email
            </Button>
            {s.source === 'settings' ? (
              <Button variant="ghost" onPress={() => setEditing(true)}>
                Change
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted">A test goes to {email}.</p>
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            This server can’t send email yet. Set its mail server here (or with SMTP_URL and
            MAIL_FROM where Fiscus runs). Until then, notifications come in Fiscus, and through the
            phone channels each person sets up.
          </p>
          <Button onPress={() => setEditing(true)}>Set up email</Button>
        </>
      )}
      {editing && s ? <MailForm status={s} onDone={() => setEditing(false)} /> : null}
    </Card>
  );
}

/** The mail server's settings, for an admin to save, change or remove. */
export function MailForm({ status, onDone }: { status: MailStatus; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { withRecentAuth, dialog } = useRecentAuth();
  const saved = status.source === 'settings';
  const [host, setHost] = useState(saved ? (status.host ?? '') : '');
  const [port, setPort] = useState(String(saved ? (status.port ?? 587) : 587));
  const [security, setSecurity] = useState<MailSecurity>(
    saved ? (status.security ?? 'starttls') : 'starttls',
  );
  const [username, setUsername] = useState(saved ? (status.username ?? '') : '');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(saved ? (status.from ?? '') : '');
  const done = (r: Data<MailStatus>) => {
    queryClient.setQueryData(mailStatusQuery.queryKey, r.data);
    onDone();
  };
  const save = useMutation({
    mutationFn: () =>
      withRecentAuth(() =>
        api<Data<MailStatus>>('PUT', '/api/v1/admin/mail', {
          body: {
            host: host.trim(),
            port: Number(port),
            security,
            username: username.trim(),
            // Blank keeps the saved password; with no username, there's none to keep.
            ...(password ? { password } : !username.trim() ? { password: '' } : {}),
            from: from.trim(),
          },
        }),
      ),
    onSuccess: (r) => {
      toast('Saved. Send a test email to check it.');
      done(r);
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => withRecentAuth(() => api<Data<MailStatus>>('DELETE', '/api/v1/admin/mail')),
    onSuccess: (r) => {
      toast('Email is off.');
      done(r);
    },
    onError: failed,
  });
  const err = save.error instanceof ReauthCancelled ? null : (save.error as ApiError | null);
  return (
    <Form
      className="mt-2"
      validationErrors={err?.fieldErrors()}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
        <TextField
          label="Mail server"
          name="host"
          value={host}
          onChange={setHost}
          isRequired
          placeholder="smtp.example.com"
        />
        <TextField
          label="Port"
          name="port"
          inputMode="numeric"
          value={port}
          onChange={(v) => setPort(v.replace(/\D/g, '').slice(0, 5))}
          isRequired
        />
      </div>
      <Select
        label="Security"
        value={security}
        onChange={(v) => {
          if (!v) return;
          const next = v as MailSecurity;
          // Move the port with it while it's still a usual one.
          if (SECURITY.some((x) => String(x.port) === port)) {
            setPort(String(SECURITY.find((x) => x.id === next)!.port));
          }
          setSecurity(next);
        }}
      >
        {SECURITY.map((x) => (
          <SelectItem key={x.id} id={x.id}>
            {x.label}
          </SelectItem>
        ))}
      </Select>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Username (optional)"
          name="username"
          value={username}
          onChange={setUsername}
          autoComplete="off"
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          description={
            saved && status.hasPassword ? 'Leave blank to keep the saved one.' : undefined
          }
        />
      </div>
      <TextField
        label="From"
        name="from"
        value={from}
        onChange={setFrom}
        isRequired
        placeholder="Fiscus <fiscus@example.com>"
        description="Who notification emails are from."
      />
      <div className="flex flex-wrap gap-2">
        {saved ? (
          <Button
            variant="ghost"
            className="mr-auto text-danger"
            isPending={remove.isPending}
            onPress={() => remove.mutate()}
          >
            Remove
          </Button>
        ) : null}
        <Button variant="secondary" onPress={onDone} className={saved ? '' : 'ml-auto'}>
          Cancel
        </Button>
        <Button type="submit" isPending={save.isPending}>
          Save
        </Button>
      </div>
      {dialog}
    </Form>
  );
}
