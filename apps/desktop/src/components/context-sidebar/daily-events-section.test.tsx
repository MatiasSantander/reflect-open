import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { DailyEventsSection } from './daily-events-section.tsx'

// The calendar queries only run in the macOS desktop webview; the test
// browser is not it either, so the platform check is mocked on.
vi.mock('@/lib/platform.ts', () => ({ isMacosDesktop: true, isNativeShell: () => true }))

// The add-meeting dialog reads the write generation from the graph provider.
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/graph', generation: 3 } }),
}))

// The action itself is covered in @reflect/core; here it is the seam the
// dialog submits through. The attendee combobox's suggestion sources are
// stubbed empty — the combobox itself is covered by its own test file.
const addMeetingToDaily = vi.hoisted(() =>
  vi.fn(async (_input: { date: string }) => ({ appended: true, createdNotes: [] })),
)
const suggestWikiTargets = vi.hoisted(() => vi.fn(async () => []))
const contactLinkSuggestions = vi.hoisted(() => vi.fn(async () => []))
// Identity by default: the email → note-title canonicalization is covered in
// @reflect/core; here it is the seam the chip-upgrade effect renders through.
const resolveMeetingAttendees = vi.hoisted(() =>
  vi.fn(async (attendees: readonly unknown[]) => [...attendees]),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  addMeetingToDaily,
  suggestWikiTargets,
  contactLinkSuggestions,
  resolveMeetingAttendees,
}))

const DATE = '2026-07-01'

function eventAt(hour: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `evt-${hour}`,
    calendarId: 'cal-work',
    title: `Meeting at ${hour}`,
    startsAt: new Date(2026, 6, 1, hour, 0).getTime(),
    endsAt: new Date(2026, 6, 1, hour + 1, 0).getTime(),
    allDay: false,
    recurring: false,
    availability: 'busy',
    canceled: false,
    attendees: [],
    ...overrides,
  }
}

let stored: Record<string, unknown>
let events: Array<Record<string, unknown>>
let contactsAuthorization: string

function installFakeBridge(): void {
  setBridge({
    invoke: async (command) => {
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          return null
        case 'calendar_list_events':
          return events
        case 'contacts_authorization_status':
          return contactsAuthorization
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

async function renderSection(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <DailyEventsSection date={DATE} />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  stored = { calendarEnabled: true, calendarIds: ['cal-work'] }
  events = []
  contactsAuthorization = 'unavailable'
  addMeetingToDaily.mockClear()
  addMeetingToDaily.mockResolvedValue({ appended: true, createdNotes: [] })
  resolveMeetingAttendees.mockClear()
  window.sessionStorage.clear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
})

describe('DailyEventsSection', () => {
  it('lists the day’s events in start order with their times', async () => {
    events = [eventAt(14), eventAt(9)]
    await renderSection()

    await expect.element(page.getByText('Meeting at 9')).toBeInTheDocument()
    const rows = page.getByRole('button', { name: /meeting at/i }).elements()
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Meeting at 9'),
      expect.stringContaining('Meeting at 14'),
    ])
    expect(rows[0]?.textContent).toContain('9:00am')
  })

  it('hides all-day and declined-by-me events', async () => {
    events = [
      eventAt(9),
      eventAt(10, { title: 'OOO banner', allDay: true }),
      eventAt(11, {
        title: 'Declined sync',
        attendees: [{ name: 'Me', isCurrentUser: true, isPerson: true, status: 'declined' }],
      }),
    ]
    await renderSection()

    await expect.element(page.getByText('Meeting at 9')).toBeInTheDocument()
    expect(page.getByText('OOO banner').query()).toBeNull()
    expect(page.getByText('Declined sync').query()).toBeNull()
  })

  it('renders nothing while the integration is off', async () => {
    stored = { calendarEnabled: false, calendarIds: ['cal-work'] }
    events = [eventAt(9)]
    const { container } = await render(
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <DailyEventsSection date={DATE} />
        </SettingsProvider>
      </QueryClientProvider>,
    )

    await vi.waitFor(() => expect(container.textContent).toBe(''))
  })

  it('clicking an event opens the dialog prefilled from the event', async () => {
    events = [
      eventAt(9, {
        title: 'Standup',
        recurring: true,
        attendees: [
          { name: 'Ada Lovelace', isCurrentUser: false, isPerson: true, status: 'accepted' },
          { name: 'Me', isCurrentUser: true, isPerson: true, status: 'accepted' },
          { name: 'Room 4', isCurrentUser: false, isPerson: false, status: 'accepted' },
        ],
      }),
    ]
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    const name = page.getByLabelText('Meeting name')
    await expect.element(name).toHaveValue('Standup')
    // Suggested attendees: people who haven't declined, excluding the user.
    await expect.element(page.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(page.getByText('Room 4').query()).toBeNull()
    // Recurring events default the create-backlinked-note choice on (v1).
    const checkbox = page.getByRole('checkbox')
    await expect.element(checkbox).toHaveAttribute('aria-checked', 'true')
  })

  it('submitting writes the meeting through addMeetingToDaily and closes', async () => {
    events = [eventAt(9, { title: 'Standup' })]
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    const attendee = page.getByLabelText('Attendees')
    await attendee.fill('Grace Hopper')
    await userEvent.keyboard('{Enter}')
    await page.getByRole('button', { name: /add to daily note/i }).click()

    await vi.waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith({
        date: DATE,
        title: 'Standup',
        attendees: [{ name: 'Grace Hopper' }],
        backlinkMeeting: false,
        lookupContacts: false,
        startTime: '9:00am',
        generation: 3,
      }),
    )
    await expectLocatorToHaveCount(page.getByLabelText('Meeting name'), 0)
  })

  it('passes invite emails and the contacts gate through to the action', async () => {
    stored = { calendarEnabled: true, calendarIds: ['cal-work'], contactsEnabled: true }
    contactsAuthorization = 'authorized'
    events = [
      eventAt(9, {
        title: 'Standup',
        attendees: [
          {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            isCurrentUser: false,
            isPerson: true,
            status: 'accepted',
          },
        ],
      }),
    ]
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await expect.element(page.getByText('Ada Lovelace')).toBeInTheDocument()
    await page.getByRole('button', { name: /add to daily note/i }).click()

    await vi.waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ name: 'Ada Lovelace', emails: ['ada@example.com'] }],
          lookupContacts: true,
        }),
      ),
    )
  })

  it('upgrades a prefilled chip to the note that owns its invite email', async () => {
    resolveMeetingAttendees.mockResolvedValueOnce([
      { name: 'Ada Lovelace', emails: ['ada@example.com'] },
    ])
    events = [
      eventAt(9, {
        title: 'Standup',
        attendees: [
          {
            name: 'ada@example.com',
            email: 'ada@example.com',
            isCurrentUser: false,
            isPerson: true,
            status: 'accepted',
          },
        ],
      }),
    ]
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await expect.element(page.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(page.getByText('ada@example.com').query()).toBeNull()

    await page.getByRole('button', { name: /add to daily note/i }).click()
    await vi.waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ name: 'Ada Lovelace', emails: ['ada@example.com'] }],
        }),
      ),
    )
  })

  it('a removed attendee chip stays out of the submission', async () => {
    events = [
      eventAt(9, {
        title: 'Standup',
        attendees: [
          { name: 'Ada Lovelace', isCurrentUser: false, isPerson: true, status: 'accepted' },
        ],
      }),
    ]
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await page.getByRole('button', { name: 'Remove Ada Lovelace' }).click()
    await page.getByRole('button', { name: /add to daily note/i }).click()

    await vi.waitFor(() =>
      expect(addMeetingToDaily).toHaveBeenCalledWith(expect.objectContaining({ attendees: [] })),
    )
  })

  it('a failed submit surfaces the error and keeps the dialog open', async () => {
    addMeetingToDaily.mockRejectedValueOnce(new Error('disk full'))
    events = [eventAt(9, { title: 'Standup' })]
    await renderSection()
    await page.getByRole('button', { name: /standup/i }).click()

    await page.getByRole('button', { name: /add to daily note/i }).click()

    await expect.element(page.getByText(/disk full/i)).toBeInTheDocument()
    await expect.element(page.getByLabelText('Meeting name')).toBeInTheDocument()
  })
})

describe('DailyEventsSection, the days after', () => {
  /** Same shape as `eventAt`, on a later day. */
  function eventOn(dayOffset: number, hour: number): Record<string, unknown> {
    return {
      ...eventAt(hour),
      id: `evt-${dayOffset}-${hour}`,
      title: `Day ${dayOffset} at ${hour}`,
      startsAt: new Date(2026, 6, 1 + dayOffset, hour, 0).getTime(),
      endsAt: new Date(2026, 6, 1 + dayOffset, hour + 1, 0).getTime(),
    }
  }

  it('asks the calendar for a week in one query, not a day at a time', async () => {
    const ranges: Array<[number, number]> = []
    setBridge({
      invoke: async (command, args) => {
        if (command === 'calendar_list_events') {
          const { start, end } = args as { start: number; end: number }
          ranges.push([start, end])
          return []
        }
        return command === 'settings_load' ? stored : null
      },
      listen: async () => () => {},
    })
    await renderSection()

    await vi.waitFor(() => expect(ranges).toHaveLength(1))
    const [start, end] = ranges[0] ?? [0, 0]
    expect((end - start) / 86_400_000).toBe(6)
  })

  it('labels the days after, and leaves the viewed day unlabelled', async () => {
    events = [eventAt(9), eventOn(1, 10), eventOn(3, 11)]
    await renderSection()

    await expect.element(page.getByText('Meeting at 9')).toBeVisible()
    await expect.element(page.getByText('Tomorrow')).toBeVisible()
    // 2026-07-04 is a Saturday.
    await expect.element(page.getByText('Saturday')).toBeVisible()
    // The viewed day names itself by being the sidebar's subject.
    await expectLocatorToHaveCount(page.getByText('Wednesday'), 0)
  })

  it('adds a later meeting to its own day, not the one being viewed', async () => {
    events = [eventOn(2, 15)]
    await renderSection()

    await userEvent.click(page.getByRole('button', { name: /Day 2 at 15/ }))
    await userEvent.click(page.getByRole('button', { name: /add to daily note/i }))

    await vi.waitFor(() => expect(addMeetingToDaily).toHaveBeenCalled())
    expect(addMeetingToDaily.mock.calls[0]?.[0]).toMatchObject({ date: '2026-07-03' })
  })
})
