import { format } from 'date-fns'
import { isIsoDate } from '@reflect/utils'
import type { DateFormat } from '../settings/schema.ts'
import { parseIsoDate } from './dates.ts'

/**
 * Render an ISO date with the date-fns pattern of the chosen format; `iso`
 * renders the date itself. A date-shaped string that names no real day (a
 * file called `daily/2026-13-45.md`) also renders as itself.
 */
function formatIsoDate(
  date: string,
  dateFormat: DateFormat,
  patterns: Record<Exclude<DateFormat, 'iso'>, string>,
): string {
  return dateFormat === 'iso' || !isIsoDate(date)
    ? date
    : format(parseIsoDate(date), patterns[dateFormat])
}

/**
 * Label for an ISO date per the user's date-format setting. `mdy` and `dmy`
 * keep the original app's daily-subject form (`Tue, June 9th, 2026` /
 * `Tue, 9th June, 2026`); `iso` renders the daily-note key itself.
 */
export function formatDayLabel(date: string, dateFormat: DateFormat): string {
  return formatIsoDate(date, dateFormat, { dmy: 'EEE, do MMMM, yyyy', mdy: 'EEE, MMMM do, yyyy' })
}

/**
 * Compact date for inline chips (the Tasks view's `[[YYYY-MM-DD]]` due link,
 * V1's blue date): `12/31/2025` for `mdy`, `31/12/2025` for `dmy`, and
 * `2025-12-31` for `iso`.
 */
export function formatShortDate(date: string, dateFormat: DateFormat): string {
  return formatIsoDate(date, dateFormat, { dmy: 'd/M/yyyy', mdy: 'M/d/yyyy' })
}

/**
 * Month and day without the year, for labels short on room (a filter chip's
 * range): `Jun 9` for `mdy`, `9 Jun` for `dmy`, and `2026-06-09` for `iso`.
 */
export function formatMonthDay(date: string, dateFormat: DateFormat): string {
  return formatIsoDate(date, dateFormat, { dmy: 'd MMM', mdy: 'MMM d' })
}
