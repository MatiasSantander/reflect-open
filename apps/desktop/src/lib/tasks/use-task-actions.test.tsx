import { act } from 'react'
import { renderHook } from 'vitest-browser-react'
import { beforeEach, expect, it, vi } from 'vitest'
import { TaskStore } from '@reflect/core'
import { useTaskActions } from './use-task-actions.ts'

const io = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn<(path: string, before: string | null, next: string) => Promise<void>>(),
  failure: vi.fn(),
  saved: vi.fn(),
}))
let store: TaskStore
vi.mock('./task-store.ts', () => ({ useTaskStore: () => store }))
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
  io.failure.mockReset()
  io.saved.mockReset()
  store = new TaskStore(io)
})

it('creates an editable task immediately without a write', async () => {
  const { result } = await renderHook(() => useTaskActions())
  const row = result.current.insert(target)
  expect(io.write).not.toHaveBeenCalled()
  act(() => result.current.remove([row!]))
  await store.flush()
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
  const first = result.current.insert(target)!
  result.current.draft(first, 'first')
  const second = result.current.insertAfter(first, target)!
  await vi.waitFor(() => expect(io.write).toHaveBeenCalledOnce())
  result.current.draft(second, 'second')
  const third = result.current.insertAfter(second, target)!
  gate.resolve()
  await store.flush()
  expect(io.failure).not.toHaveBeenCalled()
  expect(io.write.mock.calls.at(-1)?.[2]).toContain('second')
  expect(io.write.mock.calls.at(-1)?.[2].match(/\+ \[ \]/g)).toHaveLength(2)
})

it('keeps a newly completed task listed without loading the archived query', async () => {
  const { result } = await renderHook(() => useTaskActions())
  const row = result.current.insert(target)!
  act(() => {
    result.current.draft(row, 'done')
    result.current.complete([row])
  })
  expect(store.list([]).map((task) => [task.text, task.checked])).toEqual([['done', true]])
  expect(store.isRecent(row)).toBe(true)
  await store.flush()
  expect(io.write.mock.calls.at(-1)?.[2]).toContain('[x] done')
  act(() => result.current.archive())
  expect(store.list([])).toEqual([])
})
