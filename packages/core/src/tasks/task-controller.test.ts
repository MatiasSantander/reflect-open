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

it('recovers a submitted create after restart without duplicating an acknowledged file', async () => {
  const h = harness()
  const gate = Promise.withResolvers<void>()
  h.io.write.mockImplementationOnce(async () => {
    await gate.promise
    throw new Error('closed')
  })
  h.controller.submit(h.controller.begin(target), { text: 'recovered' })
  await vi.waitFor(() => expect(h.io.write).toHaveBeenCalledOnce())
  const pending = h.journal()!
  const recovered = harness(pending.attempt!.source)
  recovered.controller.restore(target.notePath, pending.commands, pending.attempt)
  await recovered.controller.flush()
  expect(recovered.source()?.match(/recovered/g)).toHaveLength(1)
  expect(recovered.io.write).not.toHaveBeenCalled()
  expect(recovered.io.failure).not.toHaveBeenCalled()
  gate.resolve()
  await h.controller.flush()
})

it('holds checkbox and date changes locally until a placeholder has content', async () => {
  const h = harness()
  const row = h.controller.begin(target)
  h.controller.submit(row, { checked: true })
  h.controller.submit(row, { dueDate: '2026-10-01' })
  expect(h.io.checkpoint).not.toHaveBeenCalled()
  expect(h.io.read).not.toHaveBeenCalled()
  h.controller.submit(h.controller.current(row), { text: 'scheduled' })
  await h.controller.flush()
  expect(h.source()).toContain('[x] scheduled [[2026-10-01]]')
})

it('converts a filled local placeholder into a bullet without losing its text', async () => {
  const h = harness()
  h.controller.submit(h.controller.begin(target), { text: 'keep this', toBullet: true })
  await h.controller.flush()
  expect(h.source()).toContain('+ keep this')
  expect(h.controller.project([], false)).toEqual([])
  expect(h.io.failure).not.toHaveBeenCalled()
})

it('does not redirect an edit to an ambiguous duplicate after an external change', async () => {
  const h = harness('+ [ ] same\n+ [ ] same\n')
  const row: TaskListItem = {
    ...target,
    revision: 'stale',
    astPath: [0],
    text: 'same',
    displayText: 'same',
    checked: false,
    dueDate: null,
    updatedAt: 1,
  }
  h.controller.submit(row, { text: 'my draft' })
  await h.controller.flush()
  expect(h.io.write).not.toHaveBeenCalled()
  expect(h.controller.project([], false).some((task) => task.text === 'my draft')).toBe(true)
  expect(h.io.failure).toHaveBeenCalledOnce()
})

it('keeps quoted backlink task identities through consecutive edits without exposing them in Tasks', async () => {
  const source = '> + [ ] quoted\n\n+ [ ] visible\n'
  const h = harness(source)
  const row: TaskListItem = {
    ...target,
    revision: await hashContent(source),
    astPath: [0, 0],
    text: 'quoted',
    displayText: 'quoted',
    checked: false,
    dueDate: null,
    updatedAt: 0,
  }
  h.controller.submit(row, { checked: true })
  h.controller.submit(row, { text: 'edited quote' })
  await h.controller.flush()
  expect(h.source()).toContain('> + [x] edited quote')
  expect(h.controller.project([], false).map((task) => task.text)).toEqual(['visible'])
  expect(h.controller.project([], true)).toEqual([])
  expect(h.io.failure).not.toHaveBeenCalled()
})

it('reconciles an external reopen and drops the recent-completion shadow', async () => {
  const source = '+ [ ] original\n'
  const h = harness(source)
  const row: TaskListItem = {
    ...target,
    revision: await hashContent(source),
    astPath: [0],
    text: 'original',
    displayText: 'original',
    checked: false,
    dueDate: null,
    updatedAt: 0,
  }
  h.controller.submit(row, { checked: true })
  await h.controller.flush()
  const recent = h.controller.project([], true)
  h.io.read.mockResolvedValue(source)
  await h.controller.reconcile()
  expect(h.controller.projectRecent(recent)).toEqual([])
  expect(h.controller.project([], false)).toHaveLength(1)
})

it('does not recreate an uncertain create after another writer changes its output', async () => {
  const h = harness()
  const row = h.controller.begin(target)
  h.controller.restore(target.notePath, [{ id: row.taskId!, row, edit: { text: 'once' } }], {
    before: null,
    source: '+ [ ] once\n',
    commands: [{ id: row.taskId!, row, edit: { text: 'once' } }],
  })
  h.io.read.mockResolvedValue('+ [ ] once\n\nexternal prose\n')
  await h.controller.flush()
  expect(h.io.write).not.toHaveBeenCalled()
  expect(h.io.failure).toHaveBeenCalledOnce()
})

it('keeps the worker usable when an early checkpoint fails but the save checkpoint succeeds', async () => {
  const h = harness()
  h.io.checkpoint.mockRejectedValueOnce(new Error('temporary journal failure'))
  h.controller.submit(h.controller.begin(target), { text: 'first' })
  await h.controller.flush()
  expect(h.source()).toContain('first')
  h.controller.submit(h.controller.begin(target), { text: 'second' })
  await h.controller.flush()
  expect(h.source()).toContain('second')
})
