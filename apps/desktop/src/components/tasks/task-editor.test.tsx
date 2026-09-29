import { useState, useSyncExternalStore } from 'react'
import { render, cleanup } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskController, type TaskListItem } from '@reflect/core'
import '@/test-utils/locator.ts'
import { TaskEditor } from './task-editor.tsx'
import { useTaskActions } from '@/lib/tasks/use-task-actions.ts'

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/task-editor-test', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      editorSpellCheck: false,
      editorSmoothCaretAnimation: false,
      timeFormat: '24h',
    },
  }),
}))
vi.mock('@/editor/use-editor-autocomplete.ts', () => ({
  useEditorAutocomplete: () => ({ onWikilinkSearch: async () => [], onTagSearch: async () => [] }),
}))
vi.mock('@/editor/use-wiki-link-navigation.ts', () => ({ useWikiLinkNavigation: () => () => {} }))
vi.mock('@/editor/use-tag-navigation.ts', () => ({ useTagNavigation: () => () => {} }))
vi.mock('@/lib/tasks/task-controller.ts', () => ({ taskController: () => controller }))

const target = {
  notePath: 'notes/a.md',
  noteTitle: 'A',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
}
let source: string | null
let controller: TaskController
const write = vi.fn<(path: string, before: string | null, next: string) => Promise<void>>()
const failure = vi.fn()

beforeEach(() => {
  source = null
  write
    .mockReset()
    .mockImplementation(async (_path: string, before: string | null, next: string) => {
      if (source !== before) throw new Error('conflict')
      source = next
    })
  failure.mockReset()
  controller = new TaskController({
    read: async () => source,
    write,
    saved: () => {},
    failure,
  })
})
afterEach(cleanup)

function Harness({ initial }: { initial: TaskListItem }) {
  const [active, setActive] = useState<TaskListItem | null>(initial)
  useSyncExternalStore(controller.subscribe, controller.snapshot)
  const actions = useTaskActions()
  const task = active && controller.current(active)
  return (
    <>
      {task && (
        <TaskEditor
          key={task.taskId}
          task={task}
          onContinue={() => setActive(actions.insertAfter(task, target))}
          onCancel={() => setActive(null)}
          onComplete={() => {}}
          onConvertToBullet={() => {}}
          onDelete={() => {
            actions.remove([task])
            setActive(null)
          }}
          onDeleteEmpty={() => {
            actions.remove([task])
            setActive(null)
          }}
          onNavigate={() => {}}
        />
      )}
      <button type="button" onClick={() => setActive(null)}>
        Close
      </button>
    </>
  )
}

it('keeps typing inside the real editor without publishing task state until the edit ends', async () => {
  const initial = controller.begin({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  const version = controller.snapshot()
  await userEvent.type(page.locate('.ProseMirror'), '你好，任务内容')
  expect(controller.snapshot()).toBe(version)
  expect(write).not.toHaveBeenCalled()
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  await vi.waitFor(() => expect(source).toContain('你好，任务内容'))
  expect(write).toHaveBeenCalledOnce()
})

it('abandons an untouched placeholder without any file write', async () => {
  const initial = controller.begin({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  await controller.flush()
  expect(write).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(controller.project([], false)).toEqual([]))
})

it('continues through twenty real editor instances while the first save is blocked', async () => {
  const gate = Promise.withResolvers<void>()
  const save = write.getMockImplementation()!
  write.mockImplementationOnce(async (...args) => {
    await gate.promise
    await save(...args)
  })
  const initial = controller.begin({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  for (let index = 0; index < 20; index++) {
    await userEvent.type(page.locate('.ProseMirror'), `task ${index}`)
    await userEvent.keyboard('{Enter}')
  }
  expect(controller.project([], false)).toHaveLength(21)
  gate.resolve()
  await controller.flush()
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  expect(source?.match(/\+ \[ \]/g)).toHaveLength(20)
  await vi.waitFor(() => expect(controller.project([], false)).toHaveLength(20))
  expect(failure).not.toHaveBeenCalled()
})

it('does not submit the task when Enter confirms an IME composition', async () => {
  const initial = controller.begin({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  const editor = page.locate('.ProseMirror')
  await userEvent.type(editor, '中文任务')
  const version = controller.snapshot()
  editor
    .element()
    .dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
  await userEvent.keyboard('{Enter}')
  expect(controller.snapshot()).toBe(version)
  expect(write).not.toHaveBeenCalled()
  editor
    .element()
    .dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文任务' }))
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  expect(source).toContain('中文任务')
})

it('discards the draft on Escape and deletes an emptied task', async () => {
  source = '+ [ ] keep\n'
  const row: TaskListItem = {
    ...target,
    revision: 'r1',
    astPath: [0],
    text: 'keep',
    displayText: 'keep',
    checked: false,
    dueDate: null,
    breadcrumbs: [],
    updatedAt: 0,
  }
  await render(<Harness initial={row} />)
  await userEvent.type(page.locate('.ProseMirror'), ' more')
  await userEvent.keyboard('{Escape}')
  await controller.flush()
  expect(write).not.toHaveBeenCalled()
})
