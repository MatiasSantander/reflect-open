import { isIsoDate, isoFromParts } from '@reflect/utils'

/**
 * The local calendar date of `date` as `YYYY-MM-DD`.
 */
export function localIsoDate(date: Date): string {
  return isoFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

/**
 * Today's local calendar date as `YYYY-MM-DD`.
 */
export function todayIso(): string {
  return localIsoDate(new Date())
}

/**
 * Parse an ISO `YYYY-MM-DD` string as local midnight; an invalid date for anything else.
 */
export function parseIsoDate(date: string): Date {
  if (!isIsoDate(date)) {
    return new Date(NaN)
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const result = new Date(0)
  result.setFullYear(year, month - 1, day)
  result.setHours(0, 0, 0, 0)
  return result
}
