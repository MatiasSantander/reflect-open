import { describe, expect, it, vi } from 'vitest'
import { TaskController, type TaskControllerIO } from './task-controller.ts'
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
  const io = {
    read: vi.fn(async () => source),
    write: vi.fn(async (_path: string, before: string | null, next: string) => {
      if (source !== before) throw new Error('conflict')
      source = next
    }),
    failure: vi.fn<TaskControllerIO['failure']>(),
    saved: vi.fn(),
  }
  return { controller: new TaskController(io), io, source: () => source }
}
async function indexedRow(source: string, astPath: number[], text: string): Promise<TaskListItem> {
  return {
    ...target,
    revision: await hashContent(source),
    astPath,
    text,
    displayText: text,
    checked: false,
    dueDate: null,
    updatedAt: 1,
  }
}

describe('task controller', () => {
  it('never reads or writes a note for abandoned empty placeholders', async () => {
    const h = harness()
    const row = h.controller.begin(target)
    expect(row.astPath).toBeUndefined()
    expect(h.controller.project([], false)).toHaveLength(1)
    h.controller.draft(row, '   ')
    expect(h.controller.commitDraft(row)).toBeNull()
    await h.controller.flush()
    expect(h.controller.project([], false)).toEqual([])
    expect(h.io.read).not.toHaveBeenCalled()
    expect(h.io.write).not.toHaveBeenCalled()
  })

  it('removes an untouched placeholder when its edit ends', async () => {
    const h = harness()
    const row = h.controller.begin(target)
    expect(h.controller.commitDraft(row)).toBeNull()
    expect(h.controller.project([], false)).toEqual([])
    expect(h.io.read).not.toHaveBeenCalled()
  })

  it('keeps a draft in memory until the edit ends, then writes it once', async () => {
    const h = harness()
    const row = h.controller.begin(target)
    const version = h.controller.snapshot()
    h.controller.draft(row, 'buy')
    h.controller.draft(row, 'buy milk')
    expect(h.controller.snapshot()).toBe(version)
    expect(h.io.write).not.toHaveBeenCalled()
    h.controller.commitDraft(row)
    await h.controller.flush()
    expect(h.io.write).toHaveBeenCalledOnce()
    expect(h.source()).toBe('+ [ ] buy milk\n')
    h.controller.commitDraft(row)
    await h.controller.flush()
    expect(h.io.write).toHaveBeenCalledOnce()
  })

  it('folds an open draft into a change made from outside the editor', async () => {
    const h = harness()
    const row = h.controller.begin(target)
    h.controller.draft(row, 'typed')
    h.controller.submit(row, { checked: true })
    await h.controller.flush()
    expect(h.source()).toBe('+ [x] typed\n')
    h.controller.draft(row, 'typed more')
    h.controller.submit(row, { dueDate: '2026-10-01' })
    await h.controller.flush()
    expect(h.source()).toBe('+ [x] typed more [[2026-10-01]]\n')
  })

  it('discards a draft and ignores changes to a task the draft emptied', async () => {
    const h = harness('+ [ ] keep\n')
    const row = await indexedRow('+ [ ] keep\n', [0], 'keep')
    h.controller.draft(row, 'never saved')
    h.controller.discardDraft(row)
    h.controller.commitDraft(row)
    await h.controller.flush()
    expect(h.io.write).not.toHaveBeenCalled()
    h.controller.draft(row, '')
    h.controller.submit(row, { checked: true })
    await h.controller.flush()
    expect(h.source()).not.toContain('keep')
    expect(h.controller.project([], false)).toEqual([])
    expect(h.io.failure).not.toHaveBeenCalled()
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
    const old = await indexedRow(source, [0], 'before')
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
    expect(h.io.saved).toHaveBeenCalledOnce()
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
    const row = { ...(await indexedRow(source, [0, 1], 'first')), breadcrumbs: ['parent'] }
    const h = harness(source)
    const next = h.controller.begin({ ...target, breadcrumbs: ['parent'] }, row)
    h.controller.submit(next, { text: 'second' })
    await h.controller.flush()
    expect(h.source()).toContain('  + [ ] second')
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('holds checkbox and date changes locally until a placeholder has content', async () => {
    const h = harness()
    const row = h.controller.begin(target)
    h.controller.submit(row, { checked: true })
    h.controller.submit(row, { dueDate: '2026-10-01' })
    expect(h.io.read).not.toHaveBeenCalled()
    expect(h.controller.current(row)).toMatchObject({ checked: true, dueDate: '2026-10-01' })
    h.controller.submit(h.controller.current(row), { text: 'scheduled' })
    await h.controller.flush()
    expect(h.source()).toContain('[x] scheduled [[2026-10-01]]')
    expect(h.io.write).toHaveBeenCalledOnce()
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
    const row = await indexedRow(source, [0, 0], 'quoted')
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
    const row = await indexedRow(source, [0], 'original')
    h.controller.submit(row, { checked: true })
    await h.controller.flush()
    const recent = h.controller.project([], true)
    h.io.read.mockResolvedValue(source)
    await h.controller.reconcile()
    expect(h.controller.projectRecent(recent)).toEqual([])
    expect(h.controller.project([], false)).toHaveLength(1)
  })

  it('adopts note metadata only from the confirmed index revision', async () => {
    const h = harness()
    h.controller.submit(h.controller.begin(target), { text: 'created' })
    await h.controller.flush()
    const confirmed = h.controller.project([], false)[0]!
    const indexed = { ...confirmed, taskId: undefined, noteTitle: 'Renamed note', isPinned: true }
    expect(h.controller.project([indexed], false)[0]?.noteTitle).toBe('Renamed note')
    expect(h.controller.project([{ ...indexed, revision: 'stale' }], false)[0]?.noteTitle).toBe(
      'Tasks',
    )
  })
})
