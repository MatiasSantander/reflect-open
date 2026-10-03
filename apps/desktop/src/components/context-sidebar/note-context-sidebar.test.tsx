import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { NoteContextSidebar } from './note-context-sidebar.tsx'

const relatedNotes = vi.hoisted(() => vi.fn())
const getOpenTasks = vi.hoisted(() => vi.fn(async () => [] as unknown[]))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  relatedNotes,
  getOpenTasks,
  getCompletedTasks: vi.fn(async () => []),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: { semanticSearchEnabled: true, dateFormat: 'mdy' },
    updateSettings: () => {},
  }),
}))
vi.mock('@/lib/tasks/use-task-actions.ts', () => ({
  useTaskActions: () => ({ toggle: vi.fn(), archive: vi.fn() }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSidebar(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <RouterProvider>
          <NoteContextSidebar path={path} />
          <RouteProbe />
        </RouterProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('NoteContextSidebar', () => {
  it('queries the note path for similar notes and shows no section without results', async () => {
    const view = await renderSidebar('notes/rust.md')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('notes/rust.md', 6))
    expect(view.getByText('Similar notes').query()).toBeNull()
    await view.unmount()
  })

  it('lists similar notes under their own section and navigates on click', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/zig.md',
        title: 'Zig',
        score: 0.8,
        snippet: 'comptime experiments',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSidebar('notes/rust.md')
    await expect.element(view.getByText('Similar notes')).toBeInTheDocument()
    await userEvent.click(view.getByText('Zig'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"note"')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/zig.md')
    await view.unmount()
  })
})

describe('NoteContextSidebar tasks', () => {
  it('shows what is still owed, the same list the daily sidebar shows', async () => {
    // What is open does not stop being true because the note you are reading
    // is not a day.
    getOpenTasks.mockResolvedValue([
      {
        notePath: 'notes/proyecto.md',
        markerOffset: 0,
        raw: '- [ ] comprar pan',
        text: 'comprar pan',
        breadcrumbs: [],
        checked: false,
        dueDate: null,
        dailyDate: null,
        noteTitle: 'Proyecto',
        isPinned: false,
        pinnedOrder: null,
        updatedAt: 0,
      },
    ])
    renderSidebar('notes/peo2.md')

    await expect.element(page.getByText('Tasks')).toBeVisible()
    await expect.element(page.getByText('comprar pan')).toBeVisible()
  })
})
