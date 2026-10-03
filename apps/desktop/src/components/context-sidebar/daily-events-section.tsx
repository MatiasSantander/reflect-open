import { useMemo, useState, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import type { CalendarEvent } from '@reflect/core'
import { formatTimeOfDay } from '@/lib/dates.ts'
import { useCalendarChangeInvalidation, useUpcomingEvents } from '@/lib/use-calendar.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { AddMeetingDialog } from './add-meeting-dialog.tsx'
import { SidebarSection } from './sidebar-section.tsx'

interface DailyEventsSectionProps {
  /** The day whose events to show — a validated ISO date. */
  date: string
}

/**
 * How far ahead the section looks. Today plus the working week after it: far
 * enough to see what is coming, short enough that the section stays a glance
 * rather than a calendar — which the month grid above it already is.
 */
const DAYS_AHEAD = 6

/**
 * The day's meetings from Apple Calendar as a context-sidebar section
 * (docs/porting/calendar-meetings-integration.md) — v1's Events sidebar,
 * extended to the days after it.
 *
 * Each row's one action opens the add-meeting dialog, which writes the
 * meeting into **that event's own** daily note, not the day being viewed: a
 * Thursday meeting added from Monday's sidebar belongs to Thursday. Renders
 * nothing when the integration is off, access is missing, or nothing is
 * scheduled — an empty box would just advertise an absent feature.
 */
export function DailyEventsSection({ date }: DailyEventsSectionProps): ReactElement | null {
  const { settings } = useSettings()
  useCalendarChangeInvalidation(settings.calendarEnabled)
  const upcoming = useUpcomingEvents(date, DAYS_AHEAD)
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

  if (days.length === 0) {
    return null
  }

  return (
    <SidebarSection storageKey="events" title="Events">
      <div className="space-y-2">
        {days.map(([day, events]) => (
          <div key={day}>
            {/* The viewed day needs no label — it is the one the sidebar is
                already about. Every other day does, or the times below read
                as today's. */}
            {day === date ? null : (
              <p className="px-3 pt-1 pb-0.5 text-2xs font-medium text-text-muted">
                {dayLabel(day, date)}
              </p>
            )}
            <ul className="space-y-1">
              {events.map((event) => (
                <li key={`${event.id}-${event.startsAt}`}>
                  <button
                    type="button"
                    onClick={() => setPending({ date: day, event })}
                    title={day === date ? 'Add to daily note' : `Add to ${dayLabel(day, date)}`}
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
 * `Tomorrow`, else the weekday — `Thursday`. Nobody reads an ISO date as a
 * day of the week, and within one week the weekday alone is unambiguous.
 */
function dayLabel(day: string, from: string): string {
  const at = new Date(`${day}T00:00:00`)
  const start = new Date(`${from}T00:00:00`)
  const ahead = Math.round((at.getTime() - start.getTime()) / 86_400_000)
  if (ahead === 1) {
    return 'Tomorrow'
  }
  return at.toLocaleDateString(undefined, { weekday: 'long' })
}
