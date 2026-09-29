import { act } from 'react'
import { renderHook } from 'vitest-browser-react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createTaskController } from '@reflect/core'
import { useTaskActions } from './use-task-actions.ts'
import { resetRecentlyCompleted, useRecentlyCompleted } from './recently-completed.ts'

const context = vi.hoisted(() => ({ generation: 1 }))
const io = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn<(path: string, before: string | null, next: string) => Promise<void>>(),
  checkpoint: vi.fn(),
  failure: vi.fn(),
  saved: vi.fn(),
}))
let controller: ReturnType<typeof createTaskController>
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', generation: context.generation } }),
}))
vi.mock('./task-controller.ts', () => ({ taskController: () => controller }))
const target = {
  notePath: 'notes/a.md',
  noteTitle: 'A',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
}

beforeEach(() => {
  let source: string | null = null
  io.read.mockReset().mockImplementation(async () => source)
  io.write
    .mockReset()
    .mockImplementation(async (_path: string, _before: string | null, next: string) => {
      source = next
    })
  io.checkpoint.mockReset().mockResolvedValue(undefined)
  io.failure.mockReset()
  io.saved.mockReset()
  controller = createTaskController(io)
  resetRecentlyCompleted()
})

it('creates an editable placeholder immediately without a persistence mutation', async () => {
  const { result } = await renderHook(() => useTaskActions())
  const row = await result.current.insert(target)
  expect(row?.taskId).toBeDefined()
  expect(row?.revision).toBeUndefined()
  expect(io.write).not.toHaveBeenCalled()
  act(() => result.current.remove([row!]))
  await controller.flush()
  expect(io.read).not.toHaveBeenCalled()
})

it('continues typing while the previous task is saving and leaves the last empty row local', async () => {
  const gate = Promise.withResolvers<void>()
  const write = io.write.getMockImplementation()!
  io.write.mockImplementationOnce(async (...args) => {
    await gate.promise
    await write(...args)
  })
  const { result } = await renderHook(() => useTaskActions())
  const first = (await result.current.insert(target))!
  const second = (await result.current.insertAfter(first, 'first', target))!
  await vi.waitFor(() => expect(io.write).toHaveBeenCalledOnce())
  const third = (await result.current.insertAfter(second, 'second', target))!
  expect(third.revision).toBeUndefined()
  gate.resolve()
  await controller.flush()
  expect(io.failure).not.toHaveBeenCalled()
  expect(io.write.mock.calls.at(-1)?.[2]).toContain('second')
  expect(io.write.mock.calls.at(-1)?.[2].match(/\+ \[ \]/g)).toHaveLength(2)
})

it('keeps a newly completed task visible without loading the archived query', async () => {
  const { result } = await renderHook(() => ({
    actions: useTaskActions(),
    recent: useRecentlyCompleted('/g', undefined),
  }))
  const row = (await result.current.actions.insert(target))!
  act(() => result.current.actions.editAndToggle(row, 'done'))
  expect(result.current.recent[0]?.checked).toBe(true)
  await controller.flush()
  expect(io.write.mock.calls.at(-1)?.[2]).toContain('[x] done')
})
