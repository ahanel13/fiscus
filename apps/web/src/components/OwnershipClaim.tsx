// SPDX-License-Identifier: AGPL-3.0-or-later
import { CLAIM_NOTICE_DAYS, type OwnershipClaim as Claim, OWNERS_AWAY_DAYS } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRoundCheck } from 'lucide-react';
import { api, type ApiError } from '../api/client.js';
import { householdQuery, membersQuery, ownershipClaimQuery } from '../api/queries.js';
import { ReauthCancelled, useRecentAuth } from './RecentAuth.js';
import { Button, ButtonLink, Card, ConfirmDialog, DateText, DialogTrigger, toast } from './ui.js';

// Ownership claims (#267, ADR 0012 §Departures item 7, D35). When no owner has used Fiscus for 30
// days, a member can ask to become an owner too. The owners are told, and any of them rejects it
// in one click, here or from the banner on every page. Using Fiscus at all ends it too.

function useClaim(householdId: string) {
  const household = useQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const state = useQuery(ownershipClaimQuery(householdId)).data;
  const claim = state?.claim ?? null;
  const claimant = claim ? members.find((m) => m.id === claim.claimantMemberId) : undefined;
  return {
    state,
    claim,
    claimantName: claimant?.displayName ?? 'Someone',
    isOwner: household?.you.role === 'owner',
    isClaimant: !!claim && claim.claimantMemberId === household?.you.memberId,
  };
}

function useEnd(householdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ claim, step }: { claim: Claim; step: 'reject' | 'withdraw' }) =>
      api('POST', `/api/v1/households/${householdId}/ownership-claims/${claim.id}/${step}`),
    onSuccess: async (_, { step }) => {
      toast(
        step === 'reject'
          ? 'Claim rejected. Nothing changes.'
          : 'Claim withdrawn. Nothing changes.',
      );
      await queryClient.invalidateQueries({ queryKey: ['households', householdId] });
    },
    onError: async (e) => {
      const err = e as ApiError;
      toast(err.title, { tone: 'error', ...(err.detail ? { description: err.detail } : {}) });
      await queryClient.invalidateQueries({ queryKey: ['households', householdId] });
    },
  });
}

/** What an open claim means, for whoever's reading. */
function ClaimText({
  claim,
  name,
  isOwner,
  isClaimant,
}: {
  claim: Claim;
  name: string;
  isOwner: boolean;
  isClaimant: boolean;
}) {
  if (isClaimant) {
    return (
      <p>
        No owner had used Fiscus for {OWNERS_AWAY_DAYS} days. Unless one of them rejects your claim,
        or uses Fiscus, by <DateText value={claim.endsAt} />, you become an owner too.
      </p>
    );
  }
  return (
    <p>
      No owner had used Fiscus for {OWNERS_AWAY_DAYS} days, so {name} asked to become an owner too.
      Unless an owner rejects it, or uses Fiscus, by <DateText value={claim.endsAt} />, {name}{' '}
      becomes an owner alongside {isOwner ? 'you' : 'them'}. Nobody stops being an owner.
      {isOwner
        ? ' Since you’re here, the claim ends on its own within a few minutes. Reject it to answer now.'
        : ''}
    </p>
  );
}

/** On every page, for the owners and the claimant while a claim is open. */
export function OwnershipClaimBanner({ householdId }: { householdId: string }) {
  const { claim, claimantName, isOwner, isClaimant } = useClaim(householdId);
  const end = useEnd(householdId);
  if (!claim || (!isOwner && !isClaimant)) return null;
  return (
    <section
      role="status"
      aria-labelledby="ownership-claim-banner"
      className="border-b border-warning/40 bg-warning-soft px-4 py-3 text-sm md:px-8"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-3">
        <UserRoundCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <h2 id="ownership-claim-banner" className="font-semibold">
            {isClaimant
              ? 'You’ve claimed ownership of this household'
              : `${claimantName} has claimed ownership of this household`}
          </h2>
          <ClaimText claim={claim} name={claimantName} isOwner={isOwner} isClaimant={isClaimant} />
        </div>
        <div className="flex flex-wrap gap-2">
          {isOwner ? (
            <Button
              size="sm"
              isPending={end.isPending}
              onPress={() => end.mutate({ claim, step: 'reject' })}
            >
              Reject claim
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              isPending={end.isPending}
              onPress={() => end.mutate({ claim, step: 'withdraw' })}
            >
              Withdraw claim
            </Button>
          )}
          <ButtonLink
            size="sm"
            variant="ghost"
            to="/h/$householdId/settings/members"
            params={{ householdId }}
          >
            Members
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

/**
 * Household settings → Members: an open claim, for everyone; or, for a member, the offer to claim
 * ownership once no owner has used Fiscus for 30 days. Nobody else learns that the owners are away.
 */
export function OwnershipClaimCard({ householdId }: { householdId: string }) {
  const { state, claim, claimantName, isOwner, isClaimant } = useClaim(householdId);
  const end = useEnd(householdId);
  const queryClient = useQueryClient();
  const { withRecentAuth, dialog } = useRecentAuth();
  const start = useMutation({
    mutationFn: () =>
      withRecentAuth(() => api('POST', `/api/v1/households/${householdId}/ownership-claims`)),
    onSuccess: async () => {
      toast('Claim sent. The owners have been told.');
      await queryClient.invalidateQueries({ queryKey: ['households', householdId] });
    },
    onError: (e) => {
      if (e instanceof ReauthCancelled) return;
      const err = e as ApiError;
      toast(err.title, { tone: 'error', ...(err.detail ? { description: err.detail } : {}) });
    },
  });

  if (claim) {
    return (
      <Card>
        <h2 className="mb-2 font-semibold">
          {isClaimant ? 'You’ve claimed ownership' : `${claimantName} has claimed ownership`}
        </h2>
        <div className="space-y-3 text-sm text-muted">
          <ClaimText claim={claim} name={claimantName} isOwner={isOwner} isClaimant={isClaimant} />
          {isOwner ? (
            <Button isPending={end.isPending} onPress={() => end.mutate({ claim, step: 'reject' })}>
              Reject claim
            </Button>
          ) : isClaimant ? (
            <Button
              variant="secondary"
              isPending={end.isPending}
              onPress={() => end.mutate({ claim, step: 'withdraw' })}
            >
              Withdraw claim
            </Button>
          ) : null}
        </div>
      </Card>
    );
  }
  if (!state?.canClaim) return null;
  return (
    <Card>
      <h2 className="mb-2 font-semibold">No owner has used Fiscus for {OWNERS_AWAY_DAYS} days</h2>
      <div className="space-y-3 text-sm text-muted">
        <p>
          If the owners can’t be reached, you can ask to become an owner too. Every owner is told,
          by email as well, and has {CLAIM_NOTICE_DAYS} days to reject it. Any owner using Fiscus
          ends it. Otherwise you become an owner alongside them, and nobody stops being one.
        </p>
        <DialogTrigger>
          <Button variant="secondary">Claim ownership</Button>
          <ConfirmDialog
            title="Claim ownership of this household?"
            confirmLabel="Claim ownership"
            onConfirm={() => start.mutateAsync()}
          >
            Every owner is told now, a week before the {CLAIM_NOTICE_DAYS} days are up, and the day
            before. If none of them rejects it or uses Fiscus by then, you become an owner too.
            Everyone in the household sees the claim, and each step is in the household’s activity.
          </ConfirmDialog>
        </DialogTrigger>
      </div>
      {dialog}
    </Card>
  );
}
