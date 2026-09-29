import { act, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from 'vitest-browser-react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { TaskAddress } from '@reflect/core'
import type { TaskMutationReceipt } from '@/lib/note-task.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { makeOpenTask } from './open-task-fixture.ts'
import { resetRecentlyCompleted, useRecentlyCompleted } from './recently-completed.ts'
import { useTaskActions } from './use-task-actions.ts'

const mocks = vi.hoisted(() => ({
  generation: 1,
  edit: vi.fn<
    (task: TaskAddress, content: string, generation: number) => Promise<TaskMutationReceipt[]>
  >(),
  batch: vi.fn(),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', generation: mocks.generation } }),
}))
vi.mock('@/lib/note-task.ts', () => ({
  editTask: mocks.edit,
  mutateTasks: mocks.batch,
  toggleTask: vi.fn(),
  insertTask: vi.fn(),
  continueTaskInContext: vi.fn(),
}))
vi.mock('@/lib/operations.ts', () => ({ startOperation: () => ({ fail: vi.fn() }) }))

beforeEach(() => {
  mocks.generation = 1
  mocks.edit.mockReset().mockResolvedValue([])
  mocks.batch.mockReset().mockResolvedValue([])
  resetRecentlyCompleted()
})

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

it('serializes separate task hooks through a native mutation scope and captures the submitted generation', async () => {
  const client = new QueryClient()
  const gate = Promise.withResolvers<TaskMutationReceipt[]>()
  mocks.edit.mockImplementationOnce(() => gate.promise)
  const { result, rerender } = await renderHook(() => [useTaskActions(), useTaskActions()], {
    wrapper: wrapper(client),
  })
  const first = makeOpenTask({ notePath: 'one.md' })
  const second = makeOpenTask({ notePath: 'two.md' })
  act(() => {
    result.current[0]!.edit(first, 'one')
    result.current[1]!.edit(second, 'two')
  })
  await vi.waitFor(() => expect(mocks.edit).toHaveBeenCalledTimes(1))
  expect(
    client
      .getMutationCache()
      .getAll()
      .some((mutation) => mutation.state.isPaused),
  ).toBe(true)
  mocks.generation = 2
  await rerender()
  gate.resolve([])
  await vi.waitFor(() => expect(mocks.edit).toHaveBeenCalledTimes(2))
  expect(mocks.edit.mock.calls.map((call) => call[2])).toEqual([1, 1])
})

it('updates the last recently completed row from the success receipt when the archived query is absent', async () => {
  const client = new QueryClient()
  const task = makeOpenTask({ text: '**done**', revision: 'before' })
  client.setQueryData(queryKeys.index.openTasks('/g'), [task])
  const receipt: TaskMutationReceipt = {
    generation: 1,
    notePath: task.notePath,
    beforeRevision: 'before',
    revision: 'after',
    source: '+ [x] **done**\n',
    paths: new Map([['[0]', [0]]]),
    tasks: [{ astPath: [0], text: '**done**', checked: true, dueDate: null, breadcrumbs: [] }],
  }
  mocks.batch.mockResolvedValue([receipt])
  const { result } = await renderHook(
    () => ({ actions: useTaskActions(), recent: useRecentlyCompleted('/g', undefined) }),
    {
      wrapper: wrapper(client),
    },
  )
  act(() => result.current.actions.complete([task]))
  await vi.waitFor(() => expect(result.current.recent[0]?.revision).toBe('after'))
  expect(result.current.recent[0]).toMatchObject({
    text: '**done**',
    displayText: 'done',
    checked: true,
  })
})
