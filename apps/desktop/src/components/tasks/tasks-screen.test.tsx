import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { userEvent, type Locator } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskListItem } from '@reflect/core'
import { act, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { queryKeys } from '@/lib/query-client.ts'
import { makeOpenTask as task } from '@/lib/tasks/open-task-fixture.ts'
import { resetRecentlyCompleted } from '@/lib/tasks/recently-completed.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import '@/test-utils/locator.ts'
import type { TaskEditHandlers } from './task-editor.tsx'
import { TasksScreen } from './tasks-screen.tsx'

const getOpenTasks = vi.hoisted(() => vi.fn())
const getCompletedTasks = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getOpenTasks,
  getCompletedTasks,
}))
vi.mock('@/lib/windows/open-in-new-window.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window.ts')>()),
  openRouteInNewWindow,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-06-14' }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' } }),
}))
vi.mock('@/editor/markdown-preview.tsx', () => ({
  MarkdownPreview: ({ content, className }: { content: string; className?: string }) => {
    const strong = /^(.*)\*\*([^*]+)\*\*(.*)$/u.exec(content)
    const before = strong?.[1] ?? ''
    const label = strong?.[2] ?? ''
    const after = strong?.[3] ?? ''
    return (
      <span data-testid="markdown-preview" className={className}>
        {strong === null ? (
          content
        ) : (
          <>
            {before}
            <strong>{label}</strong>
            {after}
          </>
        )}
      </span>
    )
  },
}))

const toggleTask = vi.hoisted(() => vi.fn())
const deleteTask = vi.hoisted(() => vi.fn())
const editTask = vi.hoisted(() => vi.fn())
const insertTask = vi.hoisted(() => vi.fn())
const continueTaskInContext = vi.hoisted(() => vi.fn())
const convertTaskToBullet = vi.hoisted(() => vi.fn())
const controllerStub = vi.hoisted(() => ({
  value: null as ReturnType<
    typeof import('@/test-utils/task-controller-stub.ts').createTaskControllerStub
  > | null,
}))
vi.mock('@/lib/tasks/task-controller.ts', async () => {
  const { createTaskControllerStub } = await import('@/test-utils/task-controller-stub.ts')
  return {
    taskController: () =>
      (controllerStub.value ??= createTaskControllerStub({
        edit: editTask,
        toggle: toggleTask,
        remove: deleteTask,
        convert: convertTaskToBullet,
        begin: insertTask,
        fail: (message) => {
          fail(message)
        },
      })),
  }
})

// Stub the real inline editor with the callback surface the row wires up, so
// selection + edit/delete/cancel routing is testable here. Typing is simulated
// by drafting into the (stubbed) task controller, exactly as the real editor
// does, so the controller's draft folding is exercised, not bypassed.
vi.mock('./task-editor', async () => {
  const { useTaskActions } = await import('@/lib/tasks/use-task-actions.ts')
  return {
    TaskEditor: ({
      task,
      onContinue,
      onCancel,
      onComplete,
      onConvertToBullet,
      onDelete,
      onDeleteEmpty,
      onNavigate,
    }: TaskEditHandlers & { task: TaskListItem }) => {
      const actions = useTaskActions()
      const latest = useRef({ task, actions })
      useLayoutEffect(() => {
        latest.current = { task, actions }
      })
      // Like the real editor, save the draft when the row leaves edit mode.
      useEffect(
        () => () => {
          latest.current.actions.commitDraft(latest.current.task)
        },
        [],
      )
      const draft = (text: string) => actions.draft(task, text)
      return (
        <div data-task-editor data-testid="task-editor">
          <span>editing: {task.displayText}</span>
          <button type="button" onClick={() => draft('edited content')}>
            stage-edit
          </button>
          <button type="button" onClick={() => draft('')}>
            stage-empty
          </button>
          <button
            type="button"
            onClick={() => {
              draft('edited content')
              onContinue()
            }}
          >
            continue-edit
          </button>
          <button type="button" onClick={() => onContinue()}>
            continue-unchanged
          </button>
          <button
            type="button"
            onClick={() => {
              draft('')
              onContinue()
            }}
          >
            continue-empty
          </button>
          <button
            type="button"
            onClick={() => {
              actions.discardDraft(task)
              onCancel()
            }}
          >
            cancel-edit
          </button>
          <button
            type="button"
            onClick={() => {
              draft('edited content')
              onComplete()
            }}
          >
            complete-edited
          </button>
          <button type="button" onClick={() => onComplete()}>
            complete-unchanged
          </button>
          <button
            type="button"
            onClick={() => {
              draft('edited content')
              onConvertToBullet()
            }}
          >
            convert-edited
          </button>
          <button type="button" onClick={() => onConvertToBullet()}>
            convert-unchanged
          </button>
          <button type="button" onClick={() => onDelete()}>
            delete-edit
          </button>
          <button type="button" onClick={() => onDeleteEmpty()}>
            delete-empty-edit
          </button>
          <button type="button" onClick={() => onNavigate(1, { span: false })}>
            nav-down
          </button>
          <button type="button" onClick={() => onNavigate(-1, { span: false })}>
            nav-up
          </button>
        </div>
      )
    },
  }
})

const fail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail })))
vi.mock('@/lib/operations.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operations.ts')>()),
  startOperation,
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderScreen(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <TasksScreen />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  ).then((view) => {
    const find = async (locator: Locator): Promise<Element> => {
      await expect.element(locator).toBeInTheDocument()
      return locator.element()
    }
    const locateByRole = view.getByRole.bind(view)
    const getByRole = (...args: Parameters<typeof view.getByRole>): Locator => {
      const [role, options] = args
      return locateByRole(
        role,
        typeof options?.name === 'string' ? { ...options, exact: true } : options,
      )
    }
    const locateByText = view.getByText.bind(view)
    const getByText = (...args: Parameters<typeof view.getByText>): Locator => {
      const [text, options] = args
      return locateByText(text, typeof text === 'string' ? { ...options, exact: true } : options)
    }
    return Object.assign(view, {
      getByRole,
      getByText,
      findByRole: (...args: Parameters<typeof view.getByRole>) => find(getByRole(...args)),
      findByTestId: (...args: Parameters<typeof view.getByTestId>) =>
        find(view.getByTestId(...args)),
      findByText: (...args: Parameters<typeof view.getByText>) => find(getByText(...args)),
      getAllByRole: (...args: Parameters<typeof view.getByRole>) => getByRole(...args).elements(),
      getAllByText: (...args: Parameters<typeof view.getByText>) => getByText(...args).elements(),
      queryByRole: (...args: Parameters<typeof view.getByRole>) => getByRole(...args).query(),
      queryByTestId: (...args: Parameters<typeof view.getByTestId>) =>
        view.getByTestId(...args).query(),
      queryByText: (...args: Parameters<typeof view.getByText>) => getByText(...args).query(),
    })
  })
}

const waitFor = vi.waitFor

beforeEach(() => {
  controllerStub.value = null
  window.sessionStorage.clear()
  getOpenTasks.mockReset()
  getCompletedTasks.mockReset()
  getCompletedTasks.mockResolvedValue([])
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  toggleTask.mockReset().mockResolvedValue([])
  deleteTask.mockReset().mockResolvedValue([])
  editTask.mockReset().mockResolvedValue([])
  insertTask.mockReset()
  insertTask.mockImplementation(async (notePath: string) => ({
    receipts: [],
    notePath,
    revision: 'inserted-revision',
    astPath: [0],
  }))
  continueTaskInContext.mockReset()
  continueTaskInContext.mockResolvedValue({
    notePath: 'notes/n.md',
    revision: 'created',
    astPath: [0],
    receipts: [],
    created: { astPath: [0], text: '' },
    offsetChanges: [],
  })
  convertTaskToBullet.mockReset().mockResolvedValue([])
  convertTaskToBullet.mockResolvedValue([])
  startOperation.mockClear()
  fail.mockReset()
  resetRecentlyCompleted()
})

afterEach(async () => {
  await cleanup()
})

// Keep native browser navigation out of keyboard-handler tests in this suite.
describe('TasksScreen', () => {
  it('shows an empty state when there are no open tasks', async () => {
    getOpenTasks.mockResolvedValue([])
    const view = await renderScreen()
    await view.findByText('No tasks to show.')
    await view.unmount()
  })

  it('does not flash an empty state while archived tasks are still loading', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    let resolveCompleted: (rows: TaskListItem[]) => void = () => {}
    getCompletedTasks.mockReturnValue(
      new Promise<TaskListItem[]>((resolve) => {
        resolveCompleted = resolve
      }),
    )
    const view = await renderScreen()

    // Open resolved to []; completed still loading → no false "empty" yet.
    await waitFor(() => expect(getOpenTasks).toHaveBeenCalled())
    expect(view.queryByText('No tasks to show.')).toBeNull()

    // Completed resolves with a task → it appears (was never reported empty).
    resolveCompleted([
      task({ notePath: 'notes/p.md', displayText: 'archived task', noteTitle: 'P', checked: true }),
    ])
    await view.findByText('archived task')
    expect(view.queryByText('No tasks to show.')).toBeNull()
    await view.unmount()
  })

  it('surfaces a failed query as an alert', async () => {
    getOpenTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load tasks.')
    await view.unmount()
  })

  it('surfaces a failed archived query as an alert, not a blank list', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load tasks.')
    await view.unmount()
  })

  it('clears the archived error when "show archived" is turned off', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', displayText: 'open task', noteTitle: 'P' }),
    ])
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    await view.findByRole('alert') // archived read failed → alert

    await userEvent.click(view.getByRole('button', { name: 'Task filters' }))
    await userEvent.click(await view.findByText('Show archived tasks'))

    // The retained archived error no longer counts → open tasks render, no alert.
    await view.findByText('open task')
    expect(view.queryByRole('alert')).toBeNull()
    await view.unmount()
  })

  it('groups tasks by date bucket then note, in display order', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'daily/2026-06-14.md',
        dailyDate: '2026-06-14',
        displayText: 'today task',
        noteTitle: '2026-06-14',
      }),
      // Overdue needs an explicit past due date (V1 asymmetry) — a bare past
      // daily-note task would be Current.
      task({
        notePath: 'notes/d.md',
        dueDate: '2026-06-10',
        displayText: 'overdue task',
        noteTitle: 'D',
      }),
      task({ notePath: 'notes/p.md', displayText: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await view.findByText('today task')
    const headers = view.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)
    expect(headers).toEqual(['Current', 'Overdue', 'Project'])
    expect(view.getByText('overdue task')).toBeDefined()
    expect(view.getByText('project task')).toBeDefined()
    await view.unmount()
  })

  it('renders one breadcrumb per consecutive task context and selects that context', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        displayText: 'first',
        noteTitle: 'Project',
        breadcrumbs: ['StartupToolbox', 'Reflections'],
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [20],
        displayText: 'second',
        noteTitle: 'Project',
        breadcrumbs: ['StartupToolbox', 'Reflections'],
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [40],
        displayText: 'third',
        noteTitle: 'Project',
        breadcrumbs: ['StartupToolbox', 'Later'],
      }),
    ])
    const view = await renderScreen()

    const context = await view.findByRole('button', {
      name: 'StartupToolbox → Reflections',
    })
    expect(view.getAllByText('StartupToolbox → Reflections')).toHaveLength(1)
    view.getByText('StartupToolbox → Later')

    await userEvent.click(context)
    expect(view.getByRole('button', { name: 'Convert to bullet 2' })).toBeDefined()
    await view.unmount()
  })

  it('hides a lone generic task breadcrumb', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        displayText: 'project task',
        noteTitle: 'Project',
        breadcrumbs: ['Tasks:'],
      }),
    ])
    const view = await renderScreen()

    await view.findByText('project task')
    expect(view.queryByText('Tasks:')).toBeNull()
    await view.unmount()
  })

  it('opens a task’s source note from its title without an arrow', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        dailyDate: null,
        dueDate: '2026-06-10',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    const sourceLink = await view.findByRole('button', { name: 'Project' })
    expect(sourceLink.querySelector('svg')).toBeNull()
    await userEvent.click(sourceLink)
    expect(view.getByTestId('route').element().textContent).toContain('notes/p.md')
    await view.unmount()
  })

  it('opens a modifier-clicked task source in a new window without selecting the row', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        dailyDate: null,
        dueDate: '2026-06-10',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    fireEvent.click(await view.findByRole('button', { name: 'Project' }), {
      metaKey: true,
      ctrlKey: true,
    })

    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/p.md',
      }),
    )
    expect(view.getByTestId('route').element().textContent).toBe('{"kind":"today"}')
    expect(view.queryByTestId('task-editor')).toBeNull()
    await view.unmount()
  })

  it('opens a modifier-clicked note-group title in a new window', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', displayText: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    fireEvent.click(await view.findByRole('button', { name: 'Project' }), {
      metaKey: true,
      ctrlKey: true,
    })

    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/p.md',
      }),
    )
    expect(view.getByTestId('route').element().textContent).toBe('{"kind":"today"}')
    await view.unmount()
  })

  it('opens a task’s source note from its date without editing the task', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'daily/2026-06-09.md',
        dailyDate: '2026-06-09',
        displayText: 'daily task',
        noteTitle: '2026-06-09',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Tue, June 9th, 2026' }))

    expect(view.getByTestId('route').element().textContent).toBe(
      '{"kind":"daily","date":"2026-06-09"}',
    )
    expect(view.queryByTestId('task-editor')).toBeNull()
    await view.unmount()
  })

  it('renders unfocused task content through the markdown preview', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        text: 'ship **bold** text',
        displayText: 'ship bold text',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    const row = await view.findByRole('button', { name: 'ship bold text' })
    expect(row.querySelector('strong')?.textContent).toContain('bold')
    expect(row.getAttribute('aria-label')).toBe('ship bold text')
    await view.unmount()
  })

  it('selects a task when clicking the row outside the text control', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], displayText: 'full row', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'full row' })
    const row = [...view.container.querySelectorAll('[data-task-key]')].find(
      (element) =>
        element.getAttribute('data-task-key') ===
        JSON.stringify(['notes/p.md', 'test-revision', [2]]),
    )
    expect(row).toBeInstanceOf(HTMLElement)
    await userEvent.click(row as HTMLElement)

    expect(view.getByTestId('task-editor').element().textContent).toContain('full row')
    await view.unmount()
  })

  it('opens the inline editor on a sole selection, and Escape exits it', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], displayText: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [3], displayText: 'second', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    // A single click selects exclusively → that row swaps to the inline editor.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    expect(view.getByTestId('task-editor').element().textContent).toContain('first')
    expect(
      view.getByRole('button', { name: 'second' }).element().getAttribute('aria-pressed'),
    ).toBe('false')

    // Clicking another row moves the sole selection (and the editor) to it.
    await userEvent.click(view.getByRole('button', { name: 'second' }))
    expect(view.getByTestId('task-editor').element().textContent).toContain('second')

    await userEvent.keyboard('{Escape}')
    expect(view.queryByTestId('task-editor')).toBeNull()
    expect(view.getByRole('button', { name: 'first' }).element().getAttribute('aria-pressed')).toBe(
      'false',
    )
    await view.unmount()
  })

  it('scrolls the focused task row into view after selection renders', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], displayText: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [3], displayText: 'second', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'second' }))
    const row = [...view.container.querySelectorAll('[data-task-key]')].find(
      (element) =>
        element.getAttribute('data-task-key') ===
        JSON.stringify(['notes/p.md', 'test-revision', [3]]),
    ) as HTMLElement

    await waitFor(() => {
      const rect = row.getBoundingClientRect()
      expect(rect.top).toBeGreaterThanOrEqual(0)
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight)
    })
    await view.unmount()
  })

  it('saves, discards, or deletes an inline edit through the editor', async () => {
    toggleTask.mockResolvedValue([])
    editTask.mockResolvedValue([])
    deleteTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'P',
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [3],
        text: 'second',
        displayText: 'second',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    // Type, then select another row → the draft is saved as the editor unmounts.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('stage-edit'))
    await userEvent.click(view.getByRole('button', { name: 'second' }))
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [2] }),
        'edited content',
        1,
      ),
    )
    expect(view.getByTestId('task-editor').element().textContent).toContain('second')

    // Re-select, clear the text, and cancel → the draft is dropped: no write, no
    // delete, edit mode exits, and the row keeps its saved text.
    await userEvent.click(view.getByRole('button', { name: 'edited content' }))
    await userEvent.click(view.getByText('stage-empty'))
    await userEvent.click(view.getByText('cancel-edit'))
    expect(view.queryByTestId('task-editor')).toBeNull()
    expect(editTask).toHaveBeenCalledTimes(1)
    expect(deleteTask).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'edited content' })).toBeDefined()

    // Re-select and delete → deleteTask, row gone.
    await userEvent.click(view.getByRole('button', { name: 'edited content' }))
    await userEvent.click(view.getByText('delete-edit'))
    await waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [2] }),
        1,
      ),
    )
    await waitFor(() => expect(view.queryByText('edited content')).toBeNull())
    await view.unmount()
  })

  it('saves the draft when ↓ moves the editor to the next row', async () => {
    editTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'P',
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [3],
        text: 'second',
        displayText: 'second',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('stage-edit'))
    // Typing alone writes nothing; the row is saved when its editor unmounts.
    expect(editTask).not.toHaveBeenCalled()
    await userEvent.click(view.getByText('nav-down'))
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [2] }),
        'edited content',
        1,
      ),
    )
    await view.findByText('editing: second')
    expect(view.getByRole('button', { name: 'edited content' })).toBeDefined()
    await view.unmount()
  })

  it('completes from the editor: edit+complete sequences the two writes', async () => {
    editTask.mockResolvedValue([])
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    // ⌘↵ with an edit → save the content, then toggle the rewritten line.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('complete-edited'))
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [2] }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ astPath: [2], revision: 'test-revision' }),
        1,
      ),
    )
    await view.unmount()
  })

  it('editing an already-completed task with ⌘↵ saves the text, never reopens it', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    editTask.mockResolvedValue([])
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'done task',
        displayText: 'done task',
        checked: true,
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'done task' }))
    await userEvent.click(view.getByText('complete-edited'))
    await waitFor(() => expect(editTask).toHaveBeenCalled())
    // The marker stays `[x]` — no toggle back to open.
    expect(toggleTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('completes from the editor: an unchanged task just toggles, no edit', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('complete-unchanged'))
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(editTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('toggles rows with ⌘-click and selects a range with shift-click', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], displayText: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [3], displayText: 'second', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [4], displayText: 'third', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name }).element().getAttribute('aria-pressed') === 'true'

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    // ⌘-click adds the row without clearing the rest (modifier set explicitly —
    // userEvent's held modifiers don't reach its synthetic click).
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'third' }), MOD_KEY)
    })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, false, true])
    expect(openRouteInNewWindow).not.toHaveBeenCalled()

    // Shift-click from the anchor (third) back to first selects the whole range.
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'first' }), { shiftKey: true })
    })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, true, true])
    await view.unmount()
  })

  it('selects all with ⌘A and moves a single selection with the arrow keys', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], displayText: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', astPath: [2], displayText: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name }).element().getAttribute('aria-pressed') === 'true'

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    // Two selected → both stay buttons (the editor only opens for a sole row).
    expect([pressed('first'), pressed('second')]).toEqual([true, true])

    // ↓ collapses to a single moving selection → that row opens the editor.
    await userEvent.keyboard('{ArrowDown}')
    expect(view.getByTestId('task-editor').element().textContent).toContain('second')
    await userEvent.keyboard('{ArrowUp}')
    expect(view.getByTestId('task-editor').element().textContent).toContain('first')
    await view.unmount()
  })

  it('completes the selection with ⌘↵', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'second',
        displayText: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select all
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))
    // Completing keeps both showing struck (the middle state), not dropped.
    await waitFor(() => expect(view.getAllByRole('button', { name: /^Reopen:/ })).toHaveLength(2))
    expect(view.getByText('first')).toBeDefined()
    await view.unmount()
  })

  it('deletes a multi-selection with ⌘⌫', async () => {
    deleteTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'second',
        displayText: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    // ⌘⌫ deletes only outside the inline editor (a multi-selection mounts none);
    // while editing a sole task it's a text edit, so it can't race the commit.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    fireEvent.click(view.getByRole('button', { name: 'second' }), MOD_KEY)
    await userEvent.keyboard('{ControlOrMeta>}{Backspace}{/ControlOrMeta}')
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.queryByText('first')).toBeNull())
    await view.unmount()
  })

  it('a note group’s "+ Add" button inserts into that note and opens the editor', async () => {
    insertTask.mockImplementation(async (notePath: string) => ({
      receipts: [],
      notePath,
      revision: 'inserted-revision',
      astPath: [0],
    }))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/proj.md',
        astPath: [2],
        text: 'a',
        displayText: 'a',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('a')
    await userEvent.click(await view.findByRole('button', { name: 'Add a task to Project' }))
    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('notes/proj.md', 1))
    // The new row's editor opens, ready to type.
    await view.findByTestId('task-editor')
    await view.unmount()
  })

  it('Overdue tasks show no "+ Add" button (V1 can’t add to an aggregate bucket)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'late',
        displayText: 'late',
        noteTitle: 'P',
        dueDate: '2026-06-01',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('late')
    expect(view.queryByRole('button', { name: /Add a task/ })).toBeNull()
    await view.unmount()
  })

  it('Return adds a task to today’s daily and opens its inline editor', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Enter}')
    // Nothing was selected, so the new task lands in today's daily note.
    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md', 1))
    // The optimistic empty row mounts its inline editor, ready to type into.
    await view.findByTestId('task-editor')
    await view.unmount()
  })

  it('dismissing the inserted row deletes the right note line (V1 empty cleanup)', async () => {
    deleteTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Enter}')
    await view.findByTestId('task-editor')
    // An empty Return-to-add row, left untouched, is removed rather than left as a
    // blank `+ [ ] ` line (the controller's `commitDraft` removes an empty task);
    // here we check the optimistic row's identity flows through, deleting the
    // freshly written daily-note line, not some other row.
    await userEvent.click(view.getByRole('button', { name: 'delete-edit' }))
    await waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'daily/2026-06-14.md' }),
        1,
      ),
    )
    await view.unmount()
  })

  it('Backspace deletes a row and lands the editor on the previous one (V1)', async () => {
    deleteTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'second',
        displayText: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    // Select the second row (its editor opens), then ⌫-delete it.
    await userEvent.click(await view.findByRole('button', { name: 'second' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'delete-empty-edit' }))

    await waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/b.md' }),
        1,
      ),
    )
    // Lands on the previous row, whose editor now opens.
    await view.findByText('editing: first')
    await view.unmount()
  })

  it('plain ⌫ leaves a multi-selection untouched (ambiguous, V1)', async () => {
    deleteTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: '',
        displayText: '',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'keep',
        displayText: 'keep',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('keep')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both
    act(() => {
      fireEvent.keyDown(view.getByLabelText('Tasks', { exact: true }), { key: 'Backspace' })
    })
    // V1 refuses a multi-row ⌫ (which row would survive is unclear).
    expect(deleteTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('Enter in the editor saves the row and opens the next task (continuous entry)', async () => {
    editTask.mockResolvedValue([])
    insertTask.mockImplementation(async (notePath: string) => ({
      receipts: [],
      notePath,
      revision: 'inserted-revision',
      astPath: [7],
    }))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    // Persists this row's edit, then appends the next task in the same note.
    await waitFor(() => expect(editTask).toHaveBeenCalled())
    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('notes/a.md', 1))
    await view.unmount()
  })

  it('keeps the edited grouped row and opens the next placeholder when saving fails', async () => {
    editTask.mockRejectedValue(new Error('This note is open.'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
        breadcrumbs: ['Project'],
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    await waitFor(() => expect(fail).toHaveBeenCalledWith('This note is open.'))
    // The failed intent stays visible on the row, and the next placeholder's editor opens.
    await view.findByText('edited content')
    await view.findByTestId('task-editor')
    await view.unmount()
  })

  it('Enter continues a scheduled grouped task despite its aggregate date bucket', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'scheduled',
        displayText: 'scheduled',
        noteTitle: 'A',
        breadcrumbs: ['Project'],
        dueDate: '2026-07-01',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'scheduled' }))
    await userEvent.click(view.getByRole('button', { name: 'continue-unchanged' }))

    await view.findByTestId('task-editor')
    expect(
      controllerStub.value
        ?.project([], false)
        .some((row) => row.revision === undefined && row.breadcrumbs.includes('Project')),
    ).toBe(true)
    await view.unmount()
  })

  it('Enter on a cleared row deletes it instead of leaving a bare task (no ghost)', async () => {
    deleteTask.mockResolvedValue([])
    insertTask.mockImplementation(async (notePath: string) => ({
      receipts: [],
      notePath,
      revision: 'inserted-revision',
      astPath: [0],
    }))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'continue-empty' }))
    // The cleared row is deleted (not edited to `+ [ ]`); editTask is never called.
    await waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/a.md' }),
        1,
      ),
    )
    expect(editTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('↑/↓ in the editor move the selection between rows (V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'second',
        displayText: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByText('editing: first')
    await userEvent.click(view.getByRole('button', { name: 'nav-down' }))
    // The editor follows the selection to the next row.
    await view.findByText('editing: second')
    await view.unmount()
  })

  it('does not reopen an already-completed task when ⌘↵ hits the selection', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'open',
        displayText: 'open',
        noteTitle: 'A',
      }),
    ])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'done',
        displayText: 'done',
        checked: true,
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'open' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // selects the open and the completed row
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    // Only the open row toggles; the completed one is left untouched.
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1)
    await view.unmount()
  })

  it('scheduling the selection writes a due-date link to each task (V1)', async () => {
    editTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'plan',
        displayText: 'plan',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'ship',
        displayText: 'ship',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor)
    await userEvent.click(view.getByRole('button', { name: /Schedule 2/ }))
    // Pick June 20 in the calendar (today mock = 2026-06-14, so it opens on June).
    await userEvent.click(await view.findByText('20'))

    await waitFor(() => expect(editTask).toHaveBeenCalledTimes(2))
    expect(editTask).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/a.md' }),
      'plan [[2026-06-20]]',
      1,
    )
    await view.unmount()
  })

  it('converts a multi-selection to bullets via the toolbar button (no editor, bulk)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'plan',
        displayText: 'plan',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'ship',
        displayText: 'ship',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor mounts)
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 2/ }))

    await waitFor(() => expect(convertTaskToBullet).toHaveBeenCalledTimes(2))
    expect(convertTaskToBullet).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/a.md' }),
      1,
    )
    expect(convertTaskToBullet).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/b.md' }),
      1,
    )
    // The converted rows are no longer checkboxes, so they leave the view.
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    expect(view.queryByText('ship')).toBeNull()
    await view.unmount()
  })

  it('converts a multi-selection to bullets with ⌘⇧K', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'plan',
        displayText: 'plan',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'ship',
        displayText: 'ship',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor mounts)
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}k{/Shift}{/ControlOrMeta}')
    await waitFor(() => expect(convertTaskToBullet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    await view.unmount()
  })

  it('converts a sole-edited row from the toolbar, saving the draft before converting', async () => {
    // The controller folds the row's open draft into the convert, so the typed
    // text is saved first, then the marker is stripped: the data-loss race Bugbot
    // flagged (convert landing before the editor's commit) can't happen.
    editTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'plan',
        displayText: 'plan',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' })) // sole → editor mounts
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 1/ }))

    // Edit first (persist the draft), then convert the rewritten line.
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/a.md', astPath: [2] }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(convertTaskToBullet).toHaveBeenCalledWith(
        expect.objectContaining({ astPath: [2], revision: 'test-revision' }),
        1,
      ),
    )
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    await view.unmount()
  })

  it('converts an edited row from the editor’s own ⌘⇧K (save then convert)', async () => {
    editTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'plan',
        displayText: 'plan',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' }))
    await userEvent.click(view.getByRole('button', { name: 'convert-edited' }))
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(expect.anything(), 'edited content', 1),
    )
    await waitFor(() => expect(convertTaskToBullet).toHaveBeenCalled())
    await view.unmount()
  })

  it('⌘↵ reopens a selection that is already all checked (toggle both ways, V1)', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'one',
        displayText: 'one',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'two',
        displayText: 'two',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('one')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor)
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}') // complete both
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))

    // The struck rows stay selected; ⌘↵ again reopens them (two more toggles).
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(4))
    await view.unmount()
  })

  it('ignores task shortcuts coming from a portaled overlay (the filters menu)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], displayText: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', astPath: [2], displayText: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()
    await view.findByRole('button', { name: 'first' })

    // The filters menu portals a role="menu" outside the list and owns its own
    // arrow navigation — a keydown from there must not drive the task selection.
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.appendChild(item)
    document.body.appendChild(menu)
    fireEvent.keyDown(item, { key: 'ArrowDown' })

    expect(view.queryByTestId('task-editor')).toBeNull()
    expect(view.getByRole('button', { name: 'first' }).element().getAttribute('aria-pressed')).toBe(
      'false',
    )
    menu.remove()
    await view.unmount()
  })

  it('completes a task when its checkbox is clicked', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
        }),
        1,
      ),
    )
    // V1's middle state: the row stays visible, struck, until archived.
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.getByText('project task')).toBeDefined()
    await view.unmount()
  })

  it('yields the struck row to the index when the task is reopened at its source note', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
        updatedAt: 100,
      }),
    ])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = await renderScreen(client)

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })

    // The checkbox is flipped back to [ ] in the note itself; the reindex
    // reports the task open again with the note's newer updatedAt. The session's
    // struck copy must yield — keeping it would shadow the live row and its
    // Reopen would fail (the [x] line is no longer in the note).
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
        updatedAt: 200,
      }),
    ])
    act(() =>
      controllerStub.value?.submit(
        task({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
          displayText: 'project task',
          noteTitle: 'Project',
          updatedAt: 200,
        }),
        { checked: false },
      ),
    )
    await client.invalidateQueries({ queryKey: queryKeys.index.all })

    await view.findByRole('button', { name: 'Complete: project task' })
    expect(view.queryByRole('button', { name: 'Reopen: project task' })).toBeNull()
    await view.unmount()
  })

  it('keeps the struck row when a refetch races the completion’s reindex', async () => {
    toggleTask.mockResolvedValue([])
    const staleRow = task({
      notePath: 'notes/p.md',
      astPath: [5],
      text: 'project task',
      displayText: 'project task',
      noteTitle: 'Project',
      updatedAt: 100,
    })
    getOpenTasks.mockResolvedValue([staleRow])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = await renderScreen(client)

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })

    // An unrelated invalidation refetches before the completion's reindex lands:
    // the index still returns the pre-completion row (same updatedAt). The row
    // must stay struck rather than flicker back to open.
    await client.invalidateQueries({ queryKey: queryKeys.index.all })

    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.queryByRole('button', { name: 'Complete: project task' })).toBeNull()
    await view.unmount()
  })

  it('completes a selected task when its checkbox is clicked', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    expect(view.getByTestId('task-editor')).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
        }),
        1,
      ),
    )
    await view.unmount()
  })

  it('completes every selected open task when a selected checkbox is clicked', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [5],
        text: 'first task',
        displayText: 'first task',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [9],
        text: 'second task',
        displayText: 'second task',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first task' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.click(view.getByRole('button', { name: 'Complete: first task' }))

    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))
    expect(toggleTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        notePath: 'notes/a.md',
        astPath: [5],
        text: 'first task',
      }),
      1,
    )
    expect(toggleTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        notePath: 'notes/b.md',
        astPath: [9],
        text: 'second task',
      }),
      1,
    )
    await view.findByRole('button', { name: 'Reopen: first task' })
    await view.findByRole('button', { name: 'Reopen: second task' })
    await view.unmount()
  })

  it('reopens selected checked tasks when a checked selected checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [5],
        text: 'open task',
        displayText: 'open task',
        noteTitle: 'A',
      }),
    ])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/b.md',
        astPath: [9],
        text: 'done task',
        displayText: 'done task',
        checked: true,
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'open task' })
    await view.findByRole('button', { name: 'done task' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: done task' }))

    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        notePath: 'notes/b.md',
        astPath: [9],
        text: 'done task',
      }),
      1,
    )
    await view.findByRole('button', { name: 'Complete: open task' })
    await view.findByRole('button', { name: 'Complete: done task' })
    await view.unmount()
  })

  it('saves an edited selected task before completing it from the checkbox', async () => {
    editTask.mockResolvedValue([])
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
        }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
        }),
        1,
      ),
    )
    // The checkbox flipped, the row shows the typed text, and the editor stays open.
    await view.findByRole('button', { name: 'Reopen: edited content' })
    expect(view.getByTestId('task-editor')).toBeDefined()
    await view.unmount()
  })

  it('accepts another checkbox intent while an edit write is pending', async () => {
    let resolveEdit = (): void => {
      throw new Error('edit promise was not created')
    }
    editTask.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEdit = resolve
        }),
    )
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() => expect(editTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    // The edit is still in flight; a second checkbox click is not blocked by it.
    const reopen = await view.findByRole('button', { name: 'Reopen: edited content' })
    fireEvent.click(reopen)
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))
    await view.findByRole('button', { name: 'Complete: edited content' })

    resolveEdit()
    await waitFor(() => expect(editTask).toHaveBeenCalledTimes(1))
    await view.unmount()
  })

  it('reopens a completed task when its checkbox is clicked', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
        }),
        1,
      ),
    )
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('reopens an archived completed task when its checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
        }),
        1,
      ),
    )
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('shows an open checkbox while a reopen write is pending', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    let resolveToggle = (): void => {
      throw new Error('toggle promise was not created')
    }
    toggleTask.mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          resolveToggle = () => resolve([])
        }),
    )
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))
    const complete = await view.findByRole('button', { name: 'Complete: project task' })
    expect(complete.querySelector('.lucide-circle-check')).toBeNull()
    expect(complete.querySelector('.lucide-circle')).not.toBeNull()

    resolveToggle()
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    await view.unmount()
  })

  it('keeps the reopen intent when saving fails', async () => {
    toggleTask.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('stale index'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByRole('button', { name: 'project task' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('reopens a selected completed task when its checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    expect(view.getByTestId('task-editor')).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
        }),
        1,
      ),
    )
    await view.unmount()
  })

  it('saves an edited selected completed task before reopening it from the checkbox', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    editTask.mockResolvedValue([])
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          text: 'project task',
        }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
        }),
        1,
      ),
    )
    await view.unmount()
  })

  it('keeps edited text in the ordinary task row when reopening fails', async () => {
    toggleTask.mockResolvedValue([])
    editTask.mockRejectedValue(new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(fail).toHaveBeenCalledWith('disk full'))
    // The failed edit stays as a pending intent on the row itself.
    await view.findByRole('button', { name: 'Complete: edited content' })
    await view.unmount()
  })

  it('keeps a completed task visible (struck) when archived tasks are shown', async () => {
    // With "show archived" on, completing must move the row into the completed
    // list (struck), not drop it until the refetch (Bugbot regression).
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // Flipped to completed in place — still on screen, now marked done.
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.getByText('project task')).toBeDefined()
    await view.unmount()
  })

  it('shows the Archive button after completing, and Archive hides the row', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // The row lingers struck and an Archive 1 action appears.
    const archive = await view.findByRole('button', { name: /Archive 1/ })
    expect(view.getByText('project task')).toBeDefined()

    await userEvent.click(archive)
    // Archiving hides this session's completed rows (still `[x]` on disk).
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    expect(view.queryByRole('button', { name: /Archive/ })).toBeNull()
    await view.unmount()
  })

  it('archives the session’s completed tasks with ⌘⇧↵', async () => {
    toggleTask.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        displayText: 'project task',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}{Enter}{/Shift}{/ControlOrMeta}')
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    await view.unmount()
  })

  it('retains a failed delete intent and reports the error without restoring a row', async () => {
    toggleTask.mockResolvedValue([])
    deleteTask.mockRejectedValue(new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'one',
        displayText: 'one',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    // Complete it → struck (kept showing via the session set), then try to delete.
    await userEvent.click(await view.findByRole('button', { name: 'Complete: one' }))
    await view.findByRole('button', { name: 'Reopen: one' })
    await userEvent.click(view.getByRole('button', { name: 'one' })) // select the struck row → editor opens
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'delete-edit' }))

    await waitFor(() => expect(deleteTask).toHaveBeenCalled())
    await waitFor(() => expect(fail).toHaveBeenCalledWith('disk full'))
    expect(view.queryByRole('button', { name: 'Reopen: one' })).toBeNull()
    await view.unmount()
  })

  it('keeps an optimistic completion and surfaces a failed save', async () => {
    toggleTask.mockRejectedValue(new Error('stale index'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', displayText: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    // The optimistic intent remains available for retry.
    await view.findByText('project task')
    await view.unmount()
  })

  it('keeps both optimistic rows when a bulk completion fails', async () => {
    toggleTask.mockRejectedValue(new Error('stale index'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'first',
        displayText: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        text: 'second',
        displayText: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    await view.findByRole('button', { name: 'Reopen: first' })
    await view.findByRole('button', { name: 'Reopen: second' })
    await view.unmount()
  })
})
