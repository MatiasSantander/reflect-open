import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarAuthorizationStatus, listCalendarEvents } from '../calendar/commands.ts'
import { getCloudSafeOpenTasks } from '../indexing/queries-tasks.ts'
import { promptContext } from './prompt-context.ts'

vi.mock('../calendar/commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../calendar/commands.ts')>()),
  calendarAuthorizationStatus: vi.fn(),
  listCalendarEvents: vi.fn(),
}))
vi.mock('../indexing/queries-tasks', () => ({
  getCloudSafeOpenTasks: vi.fn(),
}))

const NOW = new Date(2026, 9, 6, 9, 0)
const CALENDARS = ['work']

function task(overrides: Record<string, unknown> = {}) {
  return {
    notePath: 'notes/a.md',
    markerOffset: 0,
    raw: '- [ ] algo',
    text: 'algo',
    breadcrumbs: [],
    checked: false,
    dueDate: null,
    dailyDate: null,
    noteTitle: 'Proyecto',
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    calendarId: 'work',
    title: 'Standup',
    startsAt: new Date(2026, 9, 6, 9, 30).getTime(),
    endsAt: new Date(2026, 9, 6, 10, 0).getTime(),
    allDay: false,
    recurring: false,
    availability: 'busy' as const,
    canceled: false,
    attendees: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(calendarAuthorizationStatus).mockResolvedValue('fullAccess')
  vi.mocked(listCalendarEvents).mockResolvedValue([])
  vi.mocked(getCloudSafeOpenTasks).mockResolvedValue([])
})

describe('promptContext', () => {
  it('writes the date the way a person says it', async () => {
    const { today } = await promptContext({ now: NOW, calendarIds: CALENDARS })

    expect(today).toContain('2026')
    expect(today).not.toMatch(/^\d{4}-\d{2}-\d{2}$/u)
  })

  it('says nothing out loud, so silence is never ambiguous', async () => {
    const context = await promptContext({ now: NOW, calendarIds: CALENDARS })

    expect(context.events).toBe('No events on the calendar today.')
    expect(context.tasks).toBe('No open tasks.')
  })

  it('distinguishes an empty calendar from one it cannot read', async () => {
    vi.mocked(calendarAuthorizationStatus).mockResolvedValue('notDetermined')

    const { events } = await promptContext({ now: NOW, calendarIds: CALENDARS })

    expect(events).toContain('not granted')
  })

  it('lists today’s events with their time and who is in them', async () => {
    vi.mocked(listCalendarEvents).mockResolvedValue([
      event({
        attendees: [
          { name: 'Ana', email: 'a@x.test', status: 'accepted', isOrganizer: false, isMe: false },
        ],
      }),
    ])

    const { events } = await promptContext({ now: NOW, calendarIds: CALENDARS })

    expect(events).toBe('- 09:30–10:00 Standup (with Ana)')
  })

  it('asks the calendar only for today', async () => {
    await promptContext({ now: NOW, calendarIds: CALENDARS })

    const [start, end] = vi.mocked(listCalendarEvents).mock.calls[0] ?? []
    expect(new Date(start as number).getHours()).toBe(0)
    expect((end as number) - (start as number)).toBe(24 * 60 * 60 * 1000)
  })

  it('groups tasks by what they demand of today', async () => {
    vi.mocked(getCloudSafeOpenTasks).mockResolvedValue([
      task({ text: 'tarde', dueDate: '2026-10-01' }),
      task({ text: 'hoy', dueDate: '2026-10-06' }),
      task({ text: 'suelta' }),
      task({ text: 'después', dueDate: '2026-12-01' }),
    ] as never)

    const { tasks } = await promptContext({ now: NOW, calendarIds: CALENDARS })

    expect(tasks).toContain('Overdue:\n- tarde — Proyecto')
    expect(tasks).toContain('Due today:\n- hoy — Proyecto')
    expect(tasks).toContain('No date:\n- suelta — Proyecto')
    // A summary of today is not a summary of the month.
    expect(tasks).not.toContain('después')
  })

  it('does not let one source take the other down', async () => {
    vi.mocked(listCalendarEvents).mockRejectedValue(new Error('EventKit died'))
    vi.mocked(getCloudSafeOpenTasks).mockResolvedValue([task({ text: 'sobrevive' })] as never)

    const context = await promptContext({ now: NOW, calendarIds: CALENDARS })

    expect(context.events).toBe('No events on the calendar today.')
    expect(context.tasks).toContain('sobrevive')
  })

  it('skips the calendar entirely when the user picked none', async () => {
    const { events } = await promptContext({ now: NOW, calendarIds: [] })

    expect(events).toBe('No events on the calendar today.')
    expect(listCalendarEvents).not.toHaveBeenCalled()
  })
})
