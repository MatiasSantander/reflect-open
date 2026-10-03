import {
  calendarAuthorizationStatus,
  canReadCalendars,
  listCalendarEvents,
} from '../calendar/commands.ts'
import { displayEvents } from '../calendar/events.ts'
import { getCloudSafeOpenTasks } from '../indexing/queries-tasks.ts'
import type { OpenTask } from '../indexing/queries-tasks.ts'
import type { PromptValues } from './selection-prompts.ts'

/**
 * What a `/` menu prompt can ask the app for (Plan 26).
 *
 * A prompt that runs on no selection needs something to run *on*, and the two
 * things a day is made of are what is scheduled and what is owed. Both are
 * rendered as plain markdown rather than JSON: the model reads it better, and
 * so does anyone debugging the prompt that was actually sent.
 *
 * Every value is non-empty by construction. "Nothing" is said out loud,
 * because an empty string leaves the model guessing whether the day was free
 * or the data failed to load — and a model that guesses writes a summary of a
 * day that did not happen.
 */

/** Said when a source has nothing in it, so silence is never ambiguous. */
const NOTHING = {
  events: 'No events on the calendar today.',
  tasks: 'No open tasks.',
  noCalendarAccess: 'Calendar access is not granted, so today’s events are unknown.',
} as const

export interface PromptContextInput {
  /** When "today" is. Injected so a prompt is testable and a day is a choice. */
  now: Date
  /** The calendars the user chose to see, from settings. */
  calendarIds: readonly string[]
}

/**
 * Gather the values a slash prompt's placeholders resolve to.
 *
 * Sources are gathered independently: a calendar that is not granted must not
 * cost the user their task list, and an index that is not ready must not cost
 * them their meetings.
 */
export async function promptContext(input: PromptContextInput): Promise<PromptValues> {
  const [events, tasks] = await Promise.all([
    todaysEvents(input).catch(() => NOTHING.events),
    openTasks(input.now).catch(() => NOTHING.tasks),
  ])
  return { today: writtenDate(input.now), events, tasks }
}

/** `Monday, 6 October 2026` — how a person would say it, not an ISO stamp. */
function writtenDate(now: Date): string {
  return now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/** `09:30–10:00 Standup (with Ana, Beto)`, one per line, in time order. */
async function todaysEvents(input: PromptContextInput): Promise<string> {
  if (!canReadCalendars(await calendarAuthorizationStatus())) {
    return NOTHING.noCalendarAccess
  }
  if (input.calendarIds.length === 0) {
    return NOTHING.events
  }
  const start = new Date(input.now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const events = displayEvents(
    await listCalendarEvents(start.getTime(), end.getTime(), [...input.calendarIds]),
  )
  if (events.length === 0) {
    return NOTHING.events
  }
  return events
    .map((event) => {
      const when = event.allDay
        ? 'All day'
        : `${clockOf(new Date(event.startsAt))}–${clockOf(new Date(event.endsAt))}`
      // Attendees are what turns "Sync" into a meeting you can recognise, and
      // the model needs them to name who owes what.
      const who = event.attendees
        .map((attendee) => attendee.name.trim())
        .filter((name) => name !== '')
      const withWhom = who.length === 0 ? '' : ` (with ${who.join(', ')})`
      return `- ${when} ${event.title}${withWhom}`
    })
    .join('\n')
}

/**
 * Open tasks, grouped the way the user already reads them: what is overdue,
 * what is due today, and everything else. An undated backlog of two hundred
 * items would drown the day, so only the dated ones are listed in full.
 */
async function openTasks(now: Date): Promise<string> {
  const tasks = await getCloudSafeOpenTasks()
  if (tasks.length === 0) {
    return NOTHING.tasks
  }
  const today = isoDay(now)
  const overdue: OpenTask[] = []
  const dueToday: OpenTask[] = []
  const undated: OpenTask[] = []
  for (const task of tasks) {
    const due = task.dueDate ?? task.dailyDate
    if (due === null) {
      undated.push(task)
    } else if (due < today) {
      overdue.push(task)
    } else if (due === today) {
      dueToday.push(task)
    }
    // Future tasks are left out: a summary of today is not a summary of the
    // month, and the model will happily pad with them if they are offered.
  }
  const sections = [
    section('Overdue', overdue),
    section('Due today', dueToday),
    section('No date', undated),
  ].filter((text) => text !== '')
  return sections.length === 0 ? NOTHING.tasks : sections.join('\n\n')
}

function section(heading: string, tasks: readonly OpenTask[]): string {
  if (tasks.length === 0) {
    return ''
  }
  const lines = tasks.map((task) => {
    // The note is the context the task was written in, and without it half of
    // them read as orphan verbs.
    const where = task.noteTitle.trim()
    return where === '' ? `- ${task.text}` : `- ${task.text} — ${where}`
  })
  return `${heading}:\n${lines.join('\n')}`
}

function clockOf(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function isoDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}
