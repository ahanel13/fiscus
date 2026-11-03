// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  describeChannelError,
  describeRuleTiming,
  NOTIFICATION_KINDS,
  ruleChannels,
  ruleSettings,
  setChannelSchemas,
} from './notifications.js';

describe('notification rules (D18)', () => {
  it('defaults to In Fiscus and email as D18 sets them, with push once set up', () => {
    expect(ruleChannels('bill_due', null, [])).toEqual(['in_app', 'email']);
    expect(ruleChannels('bill_due', null, ['ntfy', 'webhook'])).toEqual([
      'in_app',
      'email',
      'ntfy',
      'webhook',
    ]);
    expect(ruleChannels('weekly_recap', null, ['ntfy'])).toEqual(['in_app', 'email']);
    expect(ruleChannels('big_transaction', null, [])).toEqual(['in_app']);
    // What the member ticked wins, in a fixed order.
    expect(ruleChannels('bill_due', ['webhook', 'in_app'], ['ntfy'])).toEqual([
      'in_app',
      'webhook',
    ]);
    expect(ruleChannels('bill_due', [], [])).toEqual([]);
  });

  it('fills in settings from the defaults, and falls back when stored ones no longer fit', () => {
    expect(ruleSettings('bill_due', undefined)).toEqual({ daysBefore: 3 });
    expect(ruleSettings('bill_due', { daysBefore: 5 })).toEqual({ daysBefore: 5 });
    expect(ruleSettings('bill_due', { daysBefore: 500 })).toEqual({ daysBefore: 3 });
    expect(ruleSettings('weekly_recap', { hour: 18 })).toEqual({ day: 'monday', hour: 18 });
    for (const kind of NOTIFICATION_KINDS) expect(ruleSettings(kind, null)).toBeTruthy();
  });

  it('says when each is sent, as the prototype does', () => {
    const t = (kind: Parameters<typeof describeRuleTiming>[0], stored?: object) =>
      describeRuleTiming(kind, ruleSettings(kind, stored));
    expect(t('bill_due')).toBe('3 days before');
    expect(t('bill_due', { daysBefore: 0 })).toBe('On the day');
    expect(t('statement_due', { daysBefore: 1 })).toBe('1 day before');
    expect(t('late')).toBe('2 days after it was expected');
    expect(t('big_transaction')).toBe('Over $500');
    expect(t('big_transaction', { overMinor: 12_345 })).toBe('Over $123.45');
    expect(t('low_balance')).toBe('Off until you pick an account');
    expect(
      describeRuleTiming(
        'low_balance',
        { accountIds: ['a'], underMinor: 100_000 },
        { accountNames: () => 'Everyday checking' },
      ),
    ).toBe('Everyday checking under $1,000, now or in the next 2 weeks');
    expect(t('budget_nearly_spent')).toBe('At 90%');
    expect(t('review')).toBe('Once a day at 9 am');
    expect(t('weekly_recap')).toBe('Mondays at 8 am');
    expect(t('weekly_recap', { day: 'sunday', hour: 0 })).toBe('Sundays at midnight');
    expect(t('weekly_recap', { day: 'friday', hour: 17 })).toBe('Fridays at 5 pm');
  });
});

describe('channel settings (#126)', () => {
  it('takes server addresses without credentials, and only http(s)', () => {
    const ntfy = setChannelSchemas.ntfy;
    expect(
      ntfy.safeParse({ detail: 'full', server: 'https://ntfy.sh', topic: 'a-b_c' }).success,
    ).toBe(true);
    expect(ntfy.safeParse({ detail: 'full', server: 'https://u:p@ntfy.sh' }).success).toBe(false);
    expect(ntfy.safeParse({ detail: 'full', server: 'file:///etc/passwd' }).success).toBe(false);
    expect(
      ntfy.safeParse({ detail: 'full', server: 'https://ntfy.sh', topic: 'a b' }).success,
    ).toBe(false);
    expect(ntfy.safeParse({ detail: 'loud', server: 'https://ntfy.sh' }).success).toBe(false);
    // A webhook's address may carry credentials: it's stored as a secret.
    expect(
      setChannelSchemas.webhook.safeParse({ detail: 'full', url: 'https://u:p@hook.test/x?k=1' })
        .success,
    ).toBe(true);
  });

  it('puts failure codes in words', () => {
    expect(describeChannelError('http_401')).toBe('The server refused it (401): check the token.');
    expect(describeChannelError('http_404')).toBe(
      'The server said not found (404): check the address.',
    );
    expect(describeChannelError('http_500')).toBe('The server answered 500.');
    expect(describeChannelError('smtp_550')).toBe('The mail server refused it (550).');
    expect(describeChannelError('timeout')).toBe('The server didn’t answer in time.');
    expect(describeChannelError('weird')).toBe('It didn’t go through (weird).');
    expect(describeChannelError(null)).toBe('It didn’t go through.');
  });
});
