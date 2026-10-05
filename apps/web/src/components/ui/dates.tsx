import {
  type CalendarDate,
  DateFormatter,
  getLocalTimeZone,
  parseDate,
  today,
} from '@internationalized/date';
import { clsx } from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import {
  Calendar as AriaCalendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  type CalendarProps,
  DateInput,
  DatePicker as AriaDatePicker,
  type DatePickerProps as AriaDatePickerProps,
  DateRangePicker as AriaDateRangePicker,
  type DateRangePickerProps as AriaDateRangePickerProps,
  type DateValue,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Popover,
  RangeCalendar as AriaRangeCalendar,
  type RangeCalendarProps,
  useLocale,
} from 'react-aria-components';
import { Button } from './button.js';
import { Description, FieldError, type FieldProps, Label } from './field.js';
import { controlStyles, cx, popoverStyles } from './utils.js';

// Dates in Fiscus come in two shapes, and they must never be mixed up:
// - calendar dates ("2026-09-30": a posted date, a due date) have no time zone; shifting them would
//   move a transaction to the wrong day.
// - instants (timestamps) are shown in the household's time zone, so everyone in the household sees
//   the same "today" (ADR 0011 §4), whatever their device is set to.

const TimeZoneContext = createContext<string | undefined>(undefined);

/** Sets the time zone instants are shown in: the household's, inside a household. */
export function TimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: ReactNode;
}) {
  return <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>;
}

/** The household's time zone, else the device's. */
export function useTimeZone(): string {
  return useContext(TimeZoneContext) ?? getLocalTimeZone();
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DateStyle = 'date' | 'short' | 'month' | 'datetime' | 'time';

const STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: 'medium' }, // Sep 30, 2026
  short: { month: 'short', day: 'numeric' }, // Sep 30
  month: { month: 'long', year: 'numeric' }, // September 2026
  datetime: { dateStyle: 'medium', timeStyle: 'short' }, // Sep 30, 2026, 4:05 PM
  time: { timeStyle: 'short' },
};

/**
 * Shows a date in the viewer's language. Pass a calendar date ("2026-09-30") or an instant (ISO
 * timestamp or Date); instants are shown in the household's time zone.
 */
export function DateText({
  value,
  format = 'date',
  className,
}: {
  value: string | Date;
  format?: DateStyle;
  className?: string;
}) {
  const householdZone = useTimeZone();
  const calendar = typeof value === 'string' && CALENDAR_DATE.test(value);
  const { locale } = useLocale();
  // A calendar date is formatted as midnight UTC in UTC, so it never shifts a day.
  const timeZone = calendar ? 'UTC' : householdZone;
  const formatter = useMemo(
    () => new DateFormatter(locale, { ...STYLES[format], timeZone }),
    [locale, format, timeZone],
  );
  const date = calendar ? parseDate(value).toDate('UTC') : new Date(value);
  const iso = calendar ? (value as string) : date.toISOString();
  return (
    <time dateTime={iso} className={className}>
      {formatter.format(date)}
    </time>
  );
}

const cellStyles =
  'flex size-10 cursor-default items-center justify-center rounded-md text-sm outline-none sm:size-9 ' +
  'hover:bg-surface-2 outside-month:hidden disabled:text-muted disabled:opacity-50 unavailable:text-muted unavailable:line-through ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

function CalendarHeader() {
  return (
    <header className="mb-2 flex items-center gap-1">
      <Button slot="previous" variant="ghost" size="icon" aria-label="Previous month">
        <ChevronLeft aria-hidden className="size-4" />
      </Button>
      <Heading className="flex-1 text-center text-sm font-semibold" />
      <Button slot="next" variant="ghost" size="icon" aria-label="Next month">
        <ChevronRight aria-hidden className="size-4" />
      </Button>
    </header>
  );
}

function Grid({ range }: { range?: boolean }) {
  return (
    <CalendarGrid className="border-separate border-spacing-y-0.5">
      <CalendarGridHeader>
        {(day) => (
          <CalendarHeaderCell className="pb-1 text-xs font-medium text-muted">
            {day}
          </CalendarHeaderCell>
        )}
      </CalendarGridHeader>
      <CalendarGridBody>
        {(date) => (
          <CalendarCell
            date={date}
            className={clsx(
              cellStyles,
              range
                ? 'selected:rounded-none selected:bg-accent-soft selection-start:rounded-l-md selection-start:bg-accent selection-start:text-accent-fg selection-end:rounded-r-md selection-end:bg-accent selection-end:text-accent-fg'
                : 'selected:bg-accent selected:text-accent-fg',
            )}
          />
        )}
      </CalendarGridBody>
    </CalendarGrid>
  );
}

export function Calendar<T extends DateValue>(props: CalendarProps<T>) {
  return (
    <AriaCalendar {...props} className="w-fit">
      <CalendarHeader />
      <Grid />
    </AriaCalendar>
  );
}

export function RangeCalendar<T extends DateValue>(props: RangeCalendarProps<T>) {
  return (
    <AriaRangeCalendar {...props} className="w-fit">
      <CalendarHeader />
      <Grid range />
    </AriaRangeCalendar>
  );
}

const toDate = (v: string | null | undefined) => (v ? parseDate(v) : v === null ? null : undefined);

function Segments({ slot }: { slot?: 'start' | 'end' }) {
  return (
    <DateInput slot={slot} className="flex">
      {(segment) => (
        <DateSegment
          segment={segment}
          className={
            // At least 24 px wide, so "1" is still an easy target (WCAG 2.5.8).
            'min-w-6 rounded-sm px-0.5 text-center tabular-nums outline-none placeholder-shown:text-muted ' +
            'type-literal:min-w-0 type-literal:px-0 focus:bg-accent focus:text-accent-fg'
          }
        />
      )}
    </DateInput>
  );
}

function PickerButton() {
  return (
    <Button variant="ghost" size="icon" aria-label="Open calendar" className="-mr-2 ml-auto">
      <CalendarDays aria-hidden className="size-4" />
    </Button>
  );
}

type Iso = string;

export type DatePickerProps = Omit<
  AriaDatePickerProps<CalendarDate>,
  'value' | 'defaultValue' | 'onChange' | 'minValue' | 'maxValue'
> &
  FieldProps & {
    /** A calendar date, "YYYY-MM-DD". */
    value?: Iso | null;
    defaultValue?: Iso | null;
    onChange?: (value: Iso | null) => void;
    minValue?: Iso;
    maxValue?: Iso;
  };

/** Pick a calendar date: type it in the viewer's format, or choose from a calendar. */
export function DatePicker({
  label,
  description,
  errorMessage,
  value,
  defaultValue,
  onChange,
  minValue,
  maxValue,
  className,
  ...props
}: DatePickerProps) {
  return (
    <AriaDatePicker
      {...props}
      {...(value !== undefined ? { value: toDate(value) } : {})}
      {...(defaultValue !== undefined ? { defaultValue: toDate(defaultValue) } : {})}
      {...(minValue ? { minValue: parseDate(minValue) } : {})}
      {...(maxValue ? { maxValue: parseDate(maxValue) } : {})}
      onChange={(d) => onChange?.(d ? d.toString() : null)}
      className={cx('flex flex-col gap-1.5', className)}
    >
      {label ? <Label>{label}</Label> : null}
      <Group
        className={clsx(
          controlStyles,
          'flex items-center focus-within:outline-2 focus-within:outline-accent',
        )}
      >
        <Segments />
        <PickerButton />
      </Group>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={clsx(popoverStyles, 'p-3')}>
        <Dialog className="outline-none" aria-label="Choose a date">
          <Calendar />
        </Dialog>
      </Popover>
    </AriaDatePicker>
  );
}

export interface IsoRange {
  start: Iso;
  end: Iso;
}

export type DateRangePickerProps = Omit<
  AriaDateRangePickerProps<CalendarDate>,
  'value' | 'defaultValue' | 'onChange' | 'minValue' | 'maxValue'
> &
  FieldProps & {
    value?: IsoRange | null;
    defaultValue?: IsoRange | null;
    onChange?: (value: IsoRange | null) => void;
    minValue?: Iso;
    maxValue?: Iso;
  };

const toRange = (r: IsoRange | null | undefined) =>
  r ? { start: parseDate(r.start), end: parseDate(r.end) } : r === null ? null : undefined;

/** Pick a custom date range (inclusive). Time-range presets live in the page header (#66). */
export function DateRangePicker({
  label,
  description,
  errorMessage,
  value,
  defaultValue,
  onChange,
  minValue,
  maxValue,
  className,
  ...props
}: DateRangePickerProps) {
  return (
    <AriaDateRangePicker
      {...props}
      {...(value !== undefined ? { value: toRange(value) } : {})}
      {...(defaultValue !== undefined ? { defaultValue: toRange(defaultValue) } : {})}
      {...(minValue ? { minValue: parseDate(minValue) } : {})}
      {...(maxValue ? { maxValue: parseDate(maxValue) } : {})}
      onChange={(r) => onChange?.(r ? { start: r.start.toString(), end: r.end.toString() } : null)}
      className={cx('flex flex-col gap-1.5', className)}
    >
      {label ? <Label>{label}</Label> : null}
      <Group
        className={clsx(
          controlStyles,
          'flex items-center gap-1 focus-within:outline-2 focus-within:outline-accent',
        )}
      >
        <Segments slot="start" />
        <span aria-hidden className="px-1 text-muted">
          –
        </span>
        <Segments slot="end" />
        <PickerButton />
      </Group>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={clsx(popoverStyles, 'p-3')}>
        <Dialog className="outline-none" aria-label="Choose dates">
          <RangeCalendar />
        </Dialog>
      </Popover>
    </AriaDateRangePicker>
  );
}

/** Today's calendar date in the household's time zone, as "YYYY-MM-DD". */
export function useToday(): Iso {
  const zone = useTimeZone();
  return useMemo(() => today(zone).toString(), [zone]);
}
