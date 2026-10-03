import { useMemo, useState, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { canReadCalendars, type CalendarEvent } from '@reflect/core'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { formatTimeOfDay } from '@/lib/dates.ts'
import { isModEvent } from '@meowdown/core'
import {
  useCalendarAuthorization,
  useCalendarChangeInvalidation,
  useUpcomingEvents,
} from '@/lib/use-calendar.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { AddMeetingDialog } from './add-meeting-dialog.tsx'
import { EventsSpanMenu, useEventSpan } from './events-span-menu.tsx'
import { SidebarSection } from './sidebar-section.tsx'

interface DailyEventsSectionProps {
  /** The day whose events to show — a validated ISO date. */
  date: string
}

/**
 * The day's meetings from Apple Calendar as a context-sidebar section
 * (docs/porting/calendar-meetings-integration.md) — v1's Events sidebar,
 * extended to the days after it.
 *
 * Each row's one action opens the add-meeting dialog, which writes the
 * meeting into **that event's own** daily note, not the day being viewed: a
 * Thursday meeting added from Monday's sidebar belongs to Thursday. Each day
 * header goes to that day.
 *
 * Renders nothing when the integration is off, no calendars are picked, or
 * access is missing — an empty box would advertise an absent feature. An
 * *empty span* is different: the section stays, because hiding it would take
 * the span control with it and trap the reader at a range they cannot widen.
 */
export function DailyEventsSection({ date }: DailyEventsSectionProps): ReactElement | null {
  const { settings } = useSettings()
  useCalendarChangeInvalidation(settings.calendarEnabled)
  const authorization = useCalendarAuthorization(settings.calendarEnabled)
  const [span, setSpan] = useEventSpan()
  const upcoming = useUpcomingEvents(date, span)
  const navigateNoteLink = useNoteLinkNavigation()
  const [pending, setPending] = useState<{ date: string; event: CalendarEvent } | null>(null)

  // Grouped in start order, which `displayEvents` already guarantees, so the
  // days come out in order without sorting them again.
  const days = useMemo(() => {
    const byDay = new Map<string, CalendarEvent[]>()
    for (const entry of upcoming) {
      const existing = byDay.get(entry.date)
      if (existing === undefined) {
        byDay.set(entry.date, [entry.event])
      } else {
        existing.push(entry.event)
      }
    }
    return [...byDay]
  }, [upcoming])

  // Off, no calendars picked, or not granted: nothing to say here, and the
  // Settings screen is where a missing permission gets explained.
  // `undefined` is "still asking", not "denied" — a flash of the section is
  // worse than waiting one query for the truth.
  const configured = settings.calendarEnabled && settings.calendarIds.length > 0
  if (!configured || authorization === undefined || !canReadCalendars(authorization)) {
    return null
  }

  return (
    <SidebarSection storageKey="events" title="Events">
      <div className="space-y-2">
        <div className="flex justify-end px-1">
          <EventsSpanMenu span={span} onSpanChange={setSpan} />
        </div>
        {days.length === 0 ? (
          <p className="px-3 py-1 text-xs text-text-muted">Nothing scheduled.</p>
        ) : null}
        {days.map(([day, events]) => (
          <div key={day}>
            {/* Every day names itself, including the one being viewed: a
                relative word like "tomorrow" is one the reader has to resolve
                against a date they have to remember. The header goes to that
                day, which is the only thing a date in a sidebar is for. */}
            <button
              type="button"
              onClick={(event) => {
                navigateNoteLink({
                  target: { kind: 'daily', date: day },
                  openInNewWindow: isModEvent(event),
                })
              }}
              className="block w-full px-3 pt-1 pb-0.5 text-left text-2xs font-medium text-text-muted hover:text-text"
            >
              {dayLabel(day)}
            </button>
            <ul className="space-y-1">
              {events.map((event) => (
                <li key={`${event.id}-${event.startsAt}`}>
                  <button
                    type="button"
                    onClick={() => setPending({ date: day, event })}
                    title={day === date ? 'Add to daily note' : `Add to ${dayLabel(day)}`}
                    className="group flex w-full items-center gap-2 rounded-md px-3 py-1 leading-5 text-text-secondary hover:bg-surface-hover hover:text-text"
                  >
                    <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                      {event.title}
                    </span>
                    <span className="flex-none text-xs tabular-nums text-text-muted">
                      {event.allDay
                        ? 'All day'
                        : formatTimeOfDay(new Date(event.startsAt), settings.timeFormat)}
                    </span>
                    <span
                      aria-hidden
                      className="flex-none opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    >
                      <Plus className="size-3.5" strokeWidth={1.75} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {pending !== null && (
        <AddMeetingDialog
          date={pending.date}
          event={pending.event}
          onClose={() => setPending(null)}
        />
      )}
    </SidebarSection>
  )
}

/**
 * `Sábado 04/10` — the weekday for reading, the date for certainty.
 *
 * Both, because neither is enough on its own: an ISO date does not say which
 * day of the week it is, and a bare weekday makes the reader count forward
 * from a day they have to remember. Capitalised because locales that
 * lowercase their weekdays still capitalise the start of a line.
 */
function dayLabel(day: string): string {
  const at = new Date(`${day}T00:00:00`)
  const weekday = at.toLocaleDateString(undefined, { weekday: 'long' })
  const stamp = `${String(at.getDate()).padStart(2, '0')}/${String(at.getMonth() + 1).padStart(2, '0')}`
  return `${weekday.charAt(0).toLocaleUpperCase()}${weekday.slice(1)} ${stamp}`
}
