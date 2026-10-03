import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  calendarAuthorizationStatus,
  dayRange,
  daysRange,
  displayEvents,
  listCalendarEvents,
  listCalendars,
  subscribeCalendarChanged,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarAuthorizationStatus,
  type Unlisten,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { isMacosDesktop } from '@/lib/platform.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * TanStack Query hooks over the calendar bindings
 * (docs/porting/calendar-meetings-integration.md). Events are fetched live —
 * nothing is cached beyond the query layer, and nothing is indexed.
 */

/** Whether calendar queries can run at all in this environment. */
function useCalendarAvailable(): boolean {
  return useBridgeReady() && isMacosDesktop
}

/**
 * The macOS calendar permission state (never prompts). The state changes
 * behind Reflect's back in System Settings, so this query opts out of the
 * app-wide focus policy and re-checks every time the
 * window regains focus: exactly the "flip it in System Settings and come
 * back" path.
 */
export function useCalendarAuthorization(
  enabled: boolean,
): CalendarAuthorizationStatus | undefined {
  const available = useCalendarAvailable()
  const query = useQuery({
    queryKey: queryKeys.calendar.authorization,
    queryFn: calendarAuthorizationStatus,
    enabled: enabled && available,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
  })
  return query.data
}

export interface CalendarsResult {
  calendars: CalendarInfo[]
  /**
   * True once a fetch has succeeded — an empty `calendars` only means "none
   * on this Mac" when this is set, not "still loading".
   */
  isLoaded: boolean
}

/** Every calendar on the Mac, for the Settings section's checkbox list. */
export function useCalendars(enabled: boolean): CalendarsResult {
  const available = useCalendarAvailable()
  const query = useQuery({
    queryKey: queryKeys.calendar.calendars,
    queryFn: listCalendars,
    enabled: enabled && available,
  })
  return useMemo(
    () => ({ calendars: query.data ?? [], isLoaded: query.isSuccess }),
    [query.data, query.isSuccess],
  )
}

/**
 * The day's displayable events (filtered and sorted by `displayEvents`) from
 * the enabled calendars. Off (or empty-selection, or non-macOS) resolves to
 * an empty list. The minute-level `staleTime` is only a backstop — the
 * EventKit change subscription (below) invalidates on real changes.
 */
export function useDayEvents(date: string): CalendarEvent[] {
  const { settings } = useSettings()
  const available = useCalendarAvailable()
  const enabled = settings.calendarEnabled && settings.calendarIds.length > 0 && available
  const query = useQuery({
    queryKey: queryKeys.calendar.events(date, settings.calendarIds),
    queryFn: () => {
      const range = dayRange(date)
      return listCalendarEvents(range.start, range.end, settings.calendarIds)
    },
    enabled,
    staleTime: 60_000,
  })
  // Gate on `enabled`, not just the cache: the query keeps its last payload
  // after the integration is switched off, and stale meetings must not
  // linger in the sidebar.
  return useMemo(() => (enabled ? displayEvents(query.data ?? []) : []), [enabled, query.data])
}

/**
 * The displayable events from `date` through the next `days - 1` days, each
 * tagged with the local ISO day it falls on.
 *
 * One query, not one per day: six round trips to EventKit to draw one list is
 * six chances to render half of it. The day is derived here rather than
 * carried from the query, because an event's day is a property of when it
 * starts, not of which window happened to catch it.
 */
export interface UpcomingEvent {
  event: CalendarEvent
  /** Local ISO day the event starts on — the daily note it belongs to. */
  date: string
}

export function useUpcomingEvents(date: string, days: number): UpcomingEvent[] {
  const { settings } = useSettings()
  const available = useCalendarAvailable()
  const enabled = settings.calendarEnabled && settings.calendarIds.length > 0 && available
  const query = useQuery({
    queryKey: queryKeys.calendar.eventsFrom(date, days, settings.calendarIds),
    queryFn: () => {
      const range = daysRange(date, days)
      return listCalendarEvents(range.start, range.end, settings.calendarIds)
    },
    enabled,
    staleTime: 60_000,
  })
  return useMemo(() => {
    if (!enabled) {
      return []
    }
    return displayEvents(query.data ?? []).map((event) => ({
      event,
      date: isoDay(new Date(event.startsAt)),
    }))
  }, [enabled, query.data])
}

function isoDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * Re-run every calendar query when EventKit reports a change (an edit in
 * Calendar.app, an account sync, a permission flip) — live reads instead of
 * v1's ten-minute poll. Mount once per surface that shows calendar data.
 */
export function useCalendarChangeInvalidation(enabled: boolean): void {
  const queryClient = useQueryClient()
  const available = useCalendarAvailable()
  useEffect(() => {
    if (!enabled || !available) {
      return
    }
    let unlisten: Unlisten | null = null
    let disposed = false
    void subscribeCalendarChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all })
    }).then((stop) => {
      if (disposed) {
        stop()
      } else {
        unlisten = stop
      }
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [available, enabled, queryClient])
}
