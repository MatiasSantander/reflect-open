import { beforeEach, expect, it, vi } from 'vitest'
import { hashContent, type TaskListItem } from '@reflect/core'
import { createNoteSession } from '@/editor/note-session.ts'
import { registerOpenDocument } from '@/editor/open-documents.ts'
import { taskController } from './task-controller.ts'
import { readTaskJournal, writeTaskJournal } from './task-journal.ts'

const readNote = vi.hoisted(() => vi.fn<(path: string, generation?: number) => Promise<string>>())
const writeNote = vi.hoisted(() =>
  vi.fn<
    (path: string, source: string, generation: number, before?: string | null) => Promise<void>
  >(),
)
vi.mock('@reflect/core', async (original) => ({
  ...(await original<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
}))
const toast = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn() }))
vi.mock('@/components/ui/toast.tsx', () => ({ toast }))

const target = {
  notePath: 'notes/a.md',
  noteTitle: 'A',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
  breadcrumbs: [],
}
beforeEach(() => {
  readNote.mockReset()
  writeNote.mockReset()
  toast.add.mockReset()
  toast.close.mockReset()
})

it('replays the journal before saving new edits submitted during startup', async () => {
  const root = crypto.randomUUID()
  let source = ''
  readNote.mockImplementation(async () => source)
  writeNote.mockImplementation(async (_path, next, _generation, before) => {
    expect(before).toBe(source)
    source = next
  })
  const row: TaskListItem = {
    ...target,
    taskId: 'restored',
    text: '',
    displayText: '',
    checked: false,
    dueDate: null,
    updatedAt: 0,
  }
  await writeTaskJournal(
    root,
    target.notePath,
    [{ id: 'restored', row, edit: { text: 'older draft' } }],
    null,
  )
  const controller = taskController(root, 7)
  controller.submit(controller.begin(target), { text: 'newer draft' })
  await controller.flush()
  expect(source).toContain('older draft')
  expect(source).toContain('newer draft')
  expect(source.match(/\+ \[ \]/g)).toHaveLength(2)
  expect(await readTaskJournal(root)).toEqual([])
  expect(toast.add).not.toHaveBeenCalled()
})

it('routes through a matching live NoteSession and preserves its dirty buffer', async () => {
  let disk = '+ [ ] original\n'
  const session = createNoteSession({
    path: target.notePath,
    io: {
      read: async () => disk,
      write: async (_path, source) => {
        disk = source
      },
    },
    classify: () => 'exact',
    onSnapshot: () => {},
    applyContent: () => {},
  })
  session.load()
  await vi.waitFor(() => expect(session.liveContent()).not.toBeNull())
  session.editorChanged('+ [ ] original\n\nunsaved prose\n')
  const unregister = registerOpenDocument({ session, generation: () => 7 })
  try {
    const controller = taskController(crypto.randomUUID(), 7)
    const row: TaskListItem = {
      ...target,
      revision: await hashContent(session.liveContent()!),
      astPath: [0],
      text: 'original',
      displayText: 'original',
      checked: false,
      dueDate: null,
      updatedAt: 0,
    }
    controller.submit(row, { text: 'edited' })
    await controller.flush()
    expect(disk).toContain('[ ] edited')
    expect(disk).toContain('unsaved prose')
    expect(writeNote).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()
  } finally {
    unregister()
    session.dispose()
  }
})

it('does not edit an identically named live note belonging to another graph generation', async () => {
  const session = createNoteSession({
    path: target.notePath,
    io: { read: async () => '+ [ ] other graph\n', write: null },
    classify: () => 'exact',
    onSnapshot: () => {},
    applyContent: () => {},
  })
  session.load()
  await vi.waitFor(() => expect(session.liveContent()).not.toBeNull())
  const unregister = registerOpenDocument({ session, generation: () => 9 })
  readNote.mockRejectedValue(new Error('stale generation'))
  try {
    const controller = taskController(crypto.randomUUID(), 7)
    controller.submit(controller.begin(target), { text: 'old graph draft' })
    await controller.flush()
    expect(session.liveContent()).toContain('other graph')
    expect(session.liveContent()).not.toContain('old graph draft')
    expect(writeNote).not.toHaveBeenCalled()
    expect(toast.add).toHaveBeenCalledOnce()
  } finally {
    unregister()
    session.dispose()
  }
})
