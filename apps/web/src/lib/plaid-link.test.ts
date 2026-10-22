// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaidExchangeSchema, plaidLinkExitSchema } from '@fiscus/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { setFlash, takeFlash } from './flash.js';
import {
  clearOAuthState,
  linkExit,
  linkMetadata,
  readOAuthState,
  saveOAuthState,
} from './plaid-link.js';

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('the OAuth return', () => {
  it('keeps the link token across a bank’s redirect, until Link is done with it', () => {
    saveOAuthState({ linkToken: 'link-sandbox-1', householdId: 'hh', connection: 'c1' });
    expect(readOAuthState()).toMatchObject({
      linkToken: 'link-sandbox-1',
      householdId: 'hh',
      connection: 'c1',
    });
    clearOAuthState();
    expect(readOAuthState()).toBeNull();
  });

  it('forgets a token older than Link allows, and anything that isn’t one', () => {
    saveOAuthState({ linkToken: 'link-sandbox-1', householdId: 'hh' });
    expect(readOAuthState(Date.now() + 5 * 60 * 60_000)).toBeNull();
    expect(localStorage.length).toBe(0);
    localStorage.setItem('fiscus.plaid-oauth', '{"linkToken":1}');
    expect(readOAuthState()).toBeNull();
    localStorage.setItem('fiscus.plaid-oauth', 'not json');
    expect(readOAuthState()).toBeNull();
  });
});

describe('Link’s metadata', () => {
  it('passes on the session, the bank and the last 4s, as the api takes them', () => {
    const link = linkMetadata({
      link_session_id: 'session-1',
      institution: { name: 'Harbor Credit Union', institution_id: 'ins_harbor_cu' },
      accounts: [
        {
          id: 'a1',
          name: 'Checking',
          mask: '4410',
          type: 'depository',
          subtype: 'checking',
          verification_status: null,
        },
        { id: 'a2', name: 'Card', mask: null, type: 'credit', subtype: 'credit card' } as never,
      ],
    } as never);
    expect(link).toEqual({
      sessionId: 'session-1',
      institutionId: 'ins_harbor_cu',
      accounts: [
        { mask: '4410', subtype: 'checking' },
        { mask: null, subtype: 'credit card' },
      ],
    });
    expect(plaidExchangeSchema.safeParse({ publicToken: 'p', link }).success).toBe(true);
  });

  it('records an exit with Plaid’s codes, never its messages', () => {
    const exit = linkExit(
      {
        error_type: 'ITEM_ERROR',
        error_code: 'INVALID_CREDENTIALS',
        error_message: 'Alex Rivera, the password is wrong',
        display_message: 'The password is wrong',
      },
      {
        link_session_id: 'session-2',
        status: 'requires_credentials',
        institution: { name: 'Harbor Credit Union', institution_id: 'ins_harbor_cu' },
        request_id: 'req-1',
      },
    );
    expect(exit).toEqual({
      sessionId: 'session-2',
      status: 'requires_credentials',
      institutionId: 'ins_harbor_cu',
      errorType: 'ITEM_ERROR',
      errorCode: 'INVALID_CREDENTIALS',
      requestId: 'req-1',
    });
    expect(JSON.stringify(exit)).not.toContain('Alex');
    expect(plaidLinkExitSchema.safeParse(exit).success).toBe(true);
    // Closed before Link started a session: nothing to record.
    expect(
      linkExit(null, { link_session_id: '', status: null, institution: null, request_id: '' }),
    ).toBeNull();
  });
});

describe('flash', () => {
  it('carries one message to the next page, once', () => {
    setFlash({ title: 'Harbor Credit Union is connected.', tone: 'success' });
    expect(takeFlash()).toEqual({ title: 'Harbor Credit Union is connected.', tone: 'success' });
    expect(takeFlash()).toBeNull();
  });

  it('ignores what isn’t a message', () => {
    sessionStorage.setItem('fiscus.flash', '{"tone":"error"}');
    expect(takeFlash()).toBeNull();
    sessionStorage.setItem('fiscus.flash', 'not json');
    expect(takeFlash()).toBeNull();
  });
});
