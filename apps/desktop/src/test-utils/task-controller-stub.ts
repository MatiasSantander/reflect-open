import type { TaskChange, TaskController, TaskListItem } from '@reflect/core'
import { taskListKey, inlineMarkdownToDisplayText } from '@reflect/core'

interface TaskControllerStubIO {
  edit: (row: TaskListItem, text: string, generation: number) => Promise<unknown>
  toggle: (row: TaskListItem, generation: number) => Promise<unknown>
  remove: (row: TaskListItem, generation: number) => Promise<unknown>
  convert: (row: TaskListItem, generation: number) => Promise<unknown>
  begin: (path: string, generation: number) => Promise<unknown>
  fail: (error: string) => void
}

/** The public surface of the task controller, for screen tests without file IO. */
export type TaskControllerStub = Pick<TaskController, keyof TaskController>

/** A command-boundary stub for screen interaction tests, without file IO. */
export function createTaskControllerStub(io: TaskControllerStubIO): TaskControllerStub {
  const rows = new Map<string, TaskListItem | null>()
  const drafts = new Map<string, string>()
  const listeners = new Set<() => void>()
  let version = 0
  const emit = () => {
    version++
    for (const listener of listeners) listener()
  }
  const current = (row: TaskListItem) => rows.get(taskListKey(row)) ?? row
  const enqueue = (row: TaskListItem, edit: TaskChange) => {
    const key = taskListKey(row)
    const before = current(row)
    const text = edit.text ?? before.text
    const next = {
      ...before,
      text,
      displayText: inlineMarkdownToDisplayText(text),
      checked: edit.checked ?? before.checked,
    }
    rows.set(key, edit.remove || edit.toBullet ? null : next)
    emit()
    void (async () => {
      try {
        if (edit.text !== undefined) await io.edit(row, edit.text, 1)
        if (edit.checked !== undefined) await io.toggle(row, 1)
        if (edit.remove) await io.remove(row, 1)
        if (edit.toBullet) await io.convert(row, 1)
      } catch (error) {
        // Failed intents remain visible until retried.
        io.fail(error instanceof Error ? error.message : String(error))
        emit()
      }
    })()
  }
  const commitDraft = (row: TaskListItem): TaskListItem | null => {
    const key = taskListKey(row)
    const text = (drafts.get(key) ?? current(row).text).trim()
    drafts.delete(key)
    if (rows.get(key) === null) return null
    if (text === '') {
      enqueue(row, { remove: true })
      return null
    }
    if (text !== current(row).text.trim()) enqueue(row, { text })
    return current(row)
  }
  return {
    begin(target, after) {
      void io.begin(target.notePath, 1)
      const row = {
        ...target,
        taskId: crypto.randomUUID(),
        text: '',
        displayText: '',
        checked: false,
        dueDate: null,
        updatedAt: 0,
        breadcrumbs: after?.breadcrumbs ?? target.breadcrumbs,
      }
      rows.set(taskListKey(row), row)
      emit()
      return row
    },
    draft(row, text) {
      drafts.set(taskListKey(row), text)
    },
    discardDraft(row) {
      drafts.delete(taskListKey(row))
    },
    commitDraft,
    submit(row, edit) {
      const key = taskListKey(row)
      if (edit.remove) drafts.delete(key)
      else if (drafts.has(key) && commitDraft(row) === null) return
      if (rows.get(key) === null) return
      if (edit.dueDate !== undefined) {
        const text = current(row).text
        edit = {
          text: edit.dueDate === null ? text : `${text} [[${edit.dueDate}]]`.trim(),
        }
      }
      enqueue(row, edit)
    },
    current,
    projectRecent: (recent) =>
      recent.flatMap((row) => {
        const latest = rows.has(taskListKey(row)) ? rows.get(taskListKey(row)) : row
        return latest?.checked ? [latest] : []
      }),
    project(indexed, checked) {
      const result = new Map(indexed.map((row) => [taskListKey(row), row]))
      for (const [key, row] of rows) {
        if (row) result.set(key, row)
        else result.delete(key)
      }
      return [...result.values()].filter((row) => row.checked === checked)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => version,
    reconcile: async () => {},
    flush: async () => {},
  }
}
