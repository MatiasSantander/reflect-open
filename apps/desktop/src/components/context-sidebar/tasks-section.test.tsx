import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTask } from '@reflect/core'
import { RouterProvider } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { TasksSection } from './tasks-section.tsx'

const getOpenTasks = vi.hoisted(() => vi.fn<() => Promise<OpenTask[]>>())
const getCompletedTasks = vi.hoisted(() => vi.fn<() => Promise<OpenTask[]>>())
const toggle = vi.hoisted(() => vi.fn())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  getOpenTasks,
  getCompletedTasks,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' }, updateSettings: () => {} }),
}))
vi.mock('@/lib/tasks/use-task-actions.ts', () => ({
  useTaskActions: () => ({ toggle }),
}))
vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-10-06' }))

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  return {
    notePath: 'notes/proyecto.md',
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

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <TasksSection />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  getOpenTasks.mockResolvedValue([])
  getCompletedTasks.mockResolvedValue([])
})

describe('TasksSection', () => {
  it('groups the way the Tasks view does, from the same query', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'vencida', dueDate: '2026-10-01', markerOffset: 1 }),
      task({ text: 'para hoy', dueDate: '2026-10-06', markerOffset: 2 }),
    ])
    await renderSection()

    await expect.element(page.getByText('vencida')).toBeVisible()
    await expect.element(page.getByText('para hoy')).toBeVisible()
    await expect.element(page.getByText('Overdue')).toBeVisible()
  })

  it('ticks a task off through the shared action', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'comprar pan' })])
    await renderSection()

    await userEvent.click(page.getByRole('checkbox', { name: /complete comprar pan/i }))

    expect(toggle).toHaveBeenCalledWith([expect.objectContaining({ text: 'comprar pan' })])
  })

  it('says so when there is nothing open, rather than showing an empty box', async () => {
    await renderSection()

    await expect.element(page.getByText('Nothing open.')).toBeVisible()
  })

  it('honours the filters the Tasks view set, so the two never disagree', async () => {
    // The same session flags the Tasks view writes.
    window.sessionStorage.setItem('reflect.tasks.filter.overdue', 'false')
    getOpenTasks.mockResolvedValue([task({ text: 'vencida', dueDate: '2026-10-01' })])
    await renderSection()

    await expect.element(page.getByText('Nothing open.')).toBeVisible()
    await expectLocatorToHaveCount(page.getByText('vencida'), 0)
  })

  it('names the note once, as the group header, not twice', async () => {
    // An undated task groups under its note, so repeating the title on the
    // row would fill a narrow column with the same word.
    getOpenTasks.mockResolvedValue([task({ text: 'algo' })])
    await renderSection()

    await expect.element(page.getByText('algo')).toBeVisible()
    await expectLocatorToHaveCount(page.getByText('Proyecto'), 1)
  })

  it('names the source note under a date bucket, which mixes many', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'vencida', dueDate: '2026-10-01' })])
    await renderSection()

    await expect.element(page.getByText('Overdue')).toBeVisible()
    await expect.element(page.getByText('Proyecto')).toBeVisible()
  })
})
