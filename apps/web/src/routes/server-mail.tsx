// SPDX-License-Identifier: AGPL-3.0-or-later
import { describeChannelError } from '@fiscus/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ApiError } from '../api/client.js';
import { mailStatusQuery } from '../api/queries.js';
import { Button, Card, Skeleton, toast } from '../components/ui.js';

/**
 * Server → Email (bills walkthrough D16, #125): whether this server sends notification email,
 * set with SMTP_URL and MAIL_FROM, and a test to your own address.
 */
export function MailSection({ email }: { email: string }) {
  const status = useQuery(mailStatusQuery);
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
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Email</h2>
      {status.isPending ? (
        <Skeleton className="h-10" />
      ) : status.data?.configured ? (
        <>
          <p className="mb-4 text-sm text-muted">
            Fiscus sends notification email from {status.data.from}, to those who choose it in their
            notification settings.
          </p>
          <Button variant="secondary" isPending={test.isPending} onPress={() => test.mutate()}>
            Send a test email
          </Button>
          <p className="mt-2 text-xs text-muted">It goes to {email}.</p>
        </>
      ) : (
        <p className="text-sm text-muted">
          This server can’t send email yet. Set <code>SMTP_URL</code> and <code>MAIL_FROM</code> for
          the api and the worker, and restart them. Until then, notifications come in Fiscus, and
          through the phone channels each person sets up.
        </p>
      )}
    </Card>
  );
}
