import { describe, expect, it, vi } from 'vitest'
import {
  createTaskController,
  type TaskControllerIO,
  type TaskAttempt,
  type TaskCommand,
} from './task-controller.ts'
import { hashContent } from '../indexing/hash.ts'
import type { TaskListItem } from '../indexing/queries-tasks.ts'

const target = {
  notePath: 'notes/tasks.md',
  noteTitle: 'Tasks',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
  breadcrumbs: [],
}
function harness(initial: string | null = null) {
  let source = initial
  let journal: { commands: readonly TaskCommand[]; attempt: TaskAttempt | null } | null = null
  const io = {
    read: vi.fn(async () => source),
    write: vi.fn(async (_path: string, before: string | null, next: string) => {
      if (source !== before) throw new Error('conflict')
      source = next
    }),
    checkpoint: vi.fn(
      async (_path: string, commands: readonly TaskCommand[], attempt: TaskAttempt | null) => {
        journal = structuredClone({ commands, attempt })
      },
    ),
    failure: vi.fn<TaskControllerIO['failure']>(),
    saved: vi.fn(),
  }
  return { controller: createTaskController(io), io, source: () => source, journal: () => journal }
}

describe('task controller', () => {
  it('never reads or writes a note for abandoned empty placeholders', async () => {
    const h = harness()
    const row = h.controller.begin(target)
    expect(row.astPath).toBeUndefined()
    expect(h.controller.project([], false)).toHaveLength(1)
    h.controller.submit(row, { text: '   ' })
    await h.controller.flush()
    expect(h.controller.project([], false)).toEqual([])
    expect(h.io.read).not.toHaveBeenCalled()
    expect(h.io.write).not.toHaveBeenCalled()
    expect(h.io.checkpoint).not.toHaveBeenCalled()
  })

  it('accepts twenty consecutive creates while a previous write is blocked', async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness()
    const write = h.io.write.getMockImplementation()!
    h.io.write.mockImplementationOnce(async (...args) => {
      await gate.promise
      await write(...args)
    })
    const first = h.controller.begin(target)
    h.controller.submit(first, { text: 'task 0' })
    await vi.waitFor(() => expect(h.io.write).toHaveBeenCalledOnce())
    for (let index = 1; index < 20; index++) {
      const row = h.controller.begin(target)
      h.controller.submit(row, { text: `task ${index}` })
    }
    const blank = h.controller.begin(target)
    expect(h.controller.project([], false)).toHaveLength(21)
    gate.resolve()
    await h.controller.flush()
    h.controller.submit(blank, { remove: true })
    expect(h.source()?.match(/\+ \[ \]/g)).toHaveLength(20)
    expect(h.source()).toContain('task 19')
    expect(h.io.failure).not.toHaveBeenCalled()
    expect(h.controller.project([], false)).toHaveLength(20)
  })

  it('does not roll back confirmed rows when the old index returns', async () => {
    const source = '+ [ ] before\n'
    const old: TaskListItem = {
      ...target,
      revision: await hashContent(source),
      astPath: [0],
      text: 'before',
      displayText: 'before',
      checked: false,
      dueDate: null,
      updatedAt: 1,
    }
    const h = harness(source)
    h.controller.submit(old, { text: 'after' })
    await h.controller.flush()
    const row = h.controller.project([old], false)[0]!
    expect(row.text).toBe('after')
    h.controller.submit(old, { checked: true })
    await h.controller.flush()
    expect(h.source()).toContain('[x] after')
    expect(h.controller.project([old], false)).toEqual([])
  })

  it('retains a failed draft and retries without creating a duplicate', async () => {
    const h = harness()
    h.io.write.mockRejectedValueOnce(new Error('disk full'))
    const row = h.controller.begin(target)
    h.controller.submit(row, { text: '保留文字' })
    await h.controller.flush()
    expect(h.controller.project([], false)[0]?.text).toBe('保留文字')
    expect(h.io.failure).toHaveBeenCalledOnce()
    const retry = h.io.failure.mock.calls[0]![2]
    retry()
    await h.controller.flush()
    expect(h.source()?.match(/保留文字/g)).toHaveLength(1)
  })

  it('recognizes a write whose acknowledgment was lost', async () => {
    const h = harness()
    const write = h.io.write.getMockImplementation()!
    h.io.write.mockImplementationOnce(async (...args) => {
      await write(...args)
      throw new Error('lost response')
    })
    const row = h.controller.begin(target)
    h.controller.submit(row, { text: 'once' })
    await h.controller.flush()
    expect(h.source()?.match(/once/g)).toHaveLength(1)
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('keeps contextual creates beside their parent rather than at the document end', async () => {
    const source = '+ parent\n  + [ ] first\n\nend\n'
    const row: TaskListItem = {
      ...target,
      breadcrumbs: ['parent'],
      revision: await hashContent(source),
      astPath: [0, 1],
      text: 'first',
      displayText: 'first',
      checked: false,
      dueDate: null,
      updatedAt: 1,
    }
    const h = harness(source)
    const next = h.controller.begin({ ...target, breadcrumbs: ['parent'] }, row)
    h.controller.submit(next, { text: 'second' })
    await h.controller.flush()
    expect(h.source()).toContain('  + [ ] second')
    expect(h.io.failure).not.toHaveBeenCalled()
  })
})
