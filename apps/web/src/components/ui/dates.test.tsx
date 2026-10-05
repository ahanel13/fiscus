import { render, screen } from '@testing-library/react';
import { I18nProvider } from 'react-aria-components';
import { describe, expect, it } from 'vitest';
import { DateText, TimeZoneProvider } from './dates.js';

const inZone = (zone: string, node: React.ReactNode, locale = 'en-US') =>
  render(
    <I18nProvider locale={locale}>
      <TimeZoneProvider timeZone={zone}>{node}</TimeZoneProvider>
    </I18nProvider>,
  );

describe('DateText', () => {
  it('never shifts a calendar date, whatever the time zone', () => {
    for (const zone of ['Pacific/Honolulu', 'UTC', 'Pacific/Kiritimati']) {
      const { unmount } = inZone(zone, <DateText value="2026-09-30" />);
      expect(screen.getByText('Sep 30, 2026')).toHaveAttribute('dateTime', '2026-09-30');
      unmount();
    }
  });

  it("shows instants in the household's time zone", () => {
    // 03:00 UTC on Oct 1 is still Sep 30 in Chicago.
    inZone('America/Chicago', <DateText value="2026-10-01T03:00:00Z" format="datetime" />);
    expect(screen.getByText(/Sep 30, 2026.*10:00\s?PM/)).toBeInTheDocument();
  });

  it("formats in the viewer's language", () => {
    inZone('UTC', <DateText value="2026-09-30" />, 'de-DE');
    expect(screen.getByText('30.09.2026')).toBeInTheDocument();
  });

  it('has short and month formats', () => {
    inZone(
      'UTC',
      <>
        <DateText value="2026-09-30" format="short" />
        <DateText value="2026-09-30" format="month" />
      </>,
    );
    expect(screen.getByText('Sep 30')).toBeInTheDocument();
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });
});
