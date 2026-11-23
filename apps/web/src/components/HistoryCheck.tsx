// SPDX-License-Identifier: AGPL-3.0-or-later
import { type HistoryPoint, parseHistoryPointCode } from '@fiscus/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import {
  acceptCurrentHistory,
  checkWitness,
  type FailureReason,
  fingerprint,
  runHistoryCheck,
  storedRebaselines,
  type Witness,
  type WitnessApi,
} from '../lib/history-witness.js';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DateText,
  DialogTrigger,
  Form,
  TextField,
  toast,
} from './ui.js';

function witnessApi(householdId: string): WitnessApi {
  const base = `/api/v1/households/${householdId}/activity`;
  return {
    proof: (from) =>
      api('GET', from ? `${base}/proof?after=${from.seq}&hash=${from.hash}` : `${base}/proof`),
    verify: () => api('GET', `${base}/verify`),
    report: (body) => api('POST', `${base}/integrity-reports`, { body }),
  };
}

/**
 * This device's check of the household's history (#264): once per page load and per household
 * switch, never on its own after that. A check that couldn't run waits for the next load.
 */
export const historyCheckQuery = (householdId: string) =>
  queryOptions({
    queryKey: ['history-check', householdId],
    queryFn: () => runHistoryCheck(householdId, witnessApi(householdId)),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

const REASONS: Record<FailureReason, string> = {
  history_diverged: 'An entry this device verified has changed, or is gone.',
  proof_unavailable: 'The server couldn’t prove the history after that point.',
  fold_mismatch: 'The entries since don’t add up to the history the server shows now.',
  seq_regressed: 'The history is shorter than it was.',
  malformed_proof: 'The server’s answer to the check wasn’t valid.',
  verify_failed: 'The server’s own check says the history is broken.',
};

/** Where this device last verified the history: a time, a position, and a fingerprint. */
function VerifiedPoint({ witness }: { witness: Witness }) {
  return (
    <>
      on <DateText value={witness.verifiedAt} format="datetime" />, at entry {witness.seq},
      fingerprint <code className="font-mono whitespace-nowrap">{fingerprint(witness.hash)}</code>
    </>
  );
}

/**
 * The warning on every page of a household whose history failed this device's check. It stays
 * until a member accepts the current history, and doesn't depend on the report reaching the
 * server.
 */
export function HistoryBanner({ householdId }: { householdId: string }) {
  const outcome = useQuery(historyCheckQuery(householdId)).data;
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: () => acceptCurrentHistory(householdId, witnessApi(householdId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['history-check', householdId] });
      toast('This device checks from the current history now.');
    },
    onError: () => toast('Couldn’t reach the server. Try again.', { tone: 'error' }),
  });
  if (outcome?.state !== 'failed') return null;
  const { failure } = outcome;
  return (
    <section
      role="alert"
      aria-labelledby="history-check-failed"
      className="border-b border-danger/40 bg-danger-soft px-4 py-3 text-sm md:px-8"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-3">
        <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id="history-check-failed" className="font-semibold text-danger">
            The history check failed on this device
          </h2>
          <p>
            {REASONS[failure.reason]} This device last verified the household’s history{' '}
            <VerifiedPoint witness={failure.lastVerified} />.
          </p>
          <p>
            Someone with access to the server may have changed past activity. Compare with another
            member’s device, and ask whoever runs the server.
            {failure.reported ? ' This device reported it in the household’s activity.' : ''}
          </p>
        </div>
        <DialogTrigger>
          <Button variant="secondary" size="sm">
            Accept current history as the new baseline
          </Button>
          <ConfirmDialog
            title="Accept the current history?"
            confirmLabel="Accept as the new baseline"
            destructive
            onConfirm={() => accept.mutateAsync()}
          >
            This device will check from the history the server shows now, and stop warning about
            this change. Do it only once you know why the history changed, for example after a
            backup was restored. This device keeps a note of the failed check.
          </ConfirmDialog>
        </DialogTrigger>
      </div>
    </section>
  );
}

/** Household settings: what this device's history check found, to compare across devices. */
export function HistoryCheckSettings({ householdId }: { householdId: string }) {
  const query = useQuery(historyCheckQuery(householdId));
  const outcome = query.data;
  const accepted = storedRebaselines(householdId).at(-1);
  return (
    <section aria-labelledby="history-check">
      <Card>
        <h2 id="history-check" className="mb-1 font-semibold">
          History check
        </h2>
        <p className="mb-3 text-sm text-muted">
          Each visit, this device checks for itself that the household’s activity history only grew:
          nothing in it was changed or removed.
        </p>
        <div className="space-y-2 text-sm">
          {!outcome ? (
            <p className="text-muted">Checking…</p>
          ) : outcome.state === 'first' ? (
            <p>History checks on this device start now.</p>
          ) : outcome.state === 'verified' ? (
            <>
              <p>
                Verified <VerifiedPoint witness={outcome.witness} />.
              </p>
              <p className="text-muted">
                On another device at the same entry, the fingerprint should be the same.
              </p>
            </>
          ) : outcome.state === 'failed' ? (
            // The banner above is the alert; this is the same, for the record.
            <p className="text-danger">
              The history check failed. This device last verified it{' '}
              <VerifiedPoint witness={outcome.failure.lastVerified} />.
            </p>
          ) : outcome.state === 'unreachable' ? (
            <p className="text-muted">
              Couldn’t check the history just now. This device tries again next time.
              {outcome.witness ? (
                <>
                  {' '}
                  It last verified it <VerifiedPoint witness={outcome.witness} />.
                </>
              ) : null}
            </p>
          ) : (
            <Alert tone="info">
              {outcome.why === 'insecure'
                ? 'This browser can’t check the history here: it needs a secure connection (HTTPS).'
                : 'This browser can’t check the history: it isn’t keeping data for this site, as in a private window.'}
            </Alert>
          )}
          {accepted && outcome?.state !== 'failed' ? (
            <p className="text-muted">
              A new baseline was accepted on this device on{' '}
              <DateText value={accepted.acceptedAt} format="datetime" />, after a failed check.
            </p>
          ) : null}
        </div>
        <KeptPointCheck householdId={householdId} />
      </Card>
    </section>
  );
}

const KEPT_REASONS: Record<FailureReason, string> = {
  history_diverged: 'The entry at that position has a different fingerprint now, or is gone.',
  proof_unavailable: 'The server couldn’t prove the history after that point.',
  fold_mismatch: 'The entries since don’t add up to the history the server shows now.',
  seq_regressed: 'The history is shorter than it was then.',
  malformed_proof: 'The server’s answer to the check wasn’t valid.',
  verify_failed: 'The server’s own check says the history is broken.',
};

/**
 * Checks a point kept outside the server, from a weekly recap email (#389): that the household's
 * history still extends it, folded here like this device's own check. It doesn't touch this
 * device's witness, and a failure isn't reported, since the code is whatever was pasted.
 */
function KeptPointCheck({ householdId }: { householdId: string }) {
  const search = useSearch({ strict: false }) as { kept?: unknown };
  const fromLink = typeof search.kept === 'string' ? search.kept : '';
  const [code, setCode] = useState(fromLink);
  const [point, setPoint] = useState<HistoryPoint | null>(() => parseHistoryPointCode(fromLink));
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // Arriving from the email's link: the check is what the page is for.
  useEffect(() => {
    if (fromLink) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [fromLink]);
  const result = useQuery({
    queryKey: ['history-kept-check', householdId, point?.seq, point?.hash],
    queryFn: () => checkWitness({ v: 1, ...point!, verifiedAt: '' }, witnessApi(householdId)),
    enabled: point !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const outcome = result.data;
  const at = point ? (
    <>
      entry {point.seq}, fingerprint{' '}
      <code className="font-mono whitespace-nowrap">{fingerprint(point.hash)}</code>
    </>
  ) : null;
  return (
    <section ref={ref} className="mt-4 border-t border-border pt-4" aria-labelledby="history-kept">
      <h3 id="history-kept" className="mb-1 text-sm font-semibold">
        Check a recap you kept
      </h3>
      <p className="mb-3 text-sm text-muted">
        Each weekly recap email ends with where the history was that week. Its “Check it” link
        brings it here, or paste the code the email gives.
      </p>
      <Form
        className="flex flex-wrap items-start gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseHistoryPointCode(code);
          setInvalid(!parsed);
          if (!parsed) return;
          if (parsed.seq === point?.seq && parsed.hash === point.hash) void result.refetch();
          else setPoint(parsed);
        }}
      >
        <TextField
          label="Code from the email"
          value={code}
          onChange={(v) => {
            setCode(v);
            setInvalid(false);
          }}
          isInvalid={invalid}
          errorMessage="That isn’t a code from a recap email. It’s an entry number, a dash, and 64 letters and digits."
          inputClassName="font-mono"
          className="min-w-0 flex-1 basis-64"
        />
        <Button type="submit" variant="secondary" className="sm:mt-7">
          Check
        </Button>
      </Form>
      {point && (result.isFetching || !outcome) ? (
        <p className="mt-3 text-sm text-muted">Checking…</p>
      ) : point && outcome ? (
        <div className="mt-3 space-y-1 text-sm">
          {outcome.state === 'verified' ? (
            <Alert tone="success">
              {outcome.grew === 0 ? (
                <>The history is still at the point in the email: {at}.</>
              ) : (
                <>
                  The history still extends the point in the email, {at}: nothing up to it was
                  changed or removed, and {outcome.grew}{' '}
                  {outcome.grew === 1 ? 'entry was' : 'entries were'} added since.
                </>
              )}
            </Alert>
          ) : outcome.state === 'failed' ? (
            <Alert tone="error">
              The history doesn’t extend the point in the email, {at}.{' '}
              {KEPT_REASONS[outcome.failure.reason]} If the code came straight from the email,
              someone with access to the server may have changed past activity. Compare with another
              member, and ask whoever runs the server.
            </Alert>
          ) : outcome.state === 'unavailable' ? (
            <Alert tone="info">
              This browser can’t check the history here: it needs a secure connection (HTTPS).
            </Alert>
          ) : (
            <p className="text-muted">Couldn’t check the history just now. Try again.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
