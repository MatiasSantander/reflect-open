import { useMemo } from 'react'
import type { TaskListItem, TaskChange } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider.tsx'
import { taskController } from './task-controller.ts'
import {
  archiveRecentlyCompleted,
  markRecentlyCompleted,
  forgetRecentlyCompleted,
} from './recently-completed.ts'
import { taskKey } from './task-identity.ts'
import type { InsertTaskTarget } from './task-insert-target.ts'

/**
 * The task changes a screen can make. Every change goes to the graph's task
 * controller, which saves a draft still open on the task first, so nothing
 * here needs to know whether the task is being edited.
 */
export interface TaskActions {
  complete: (tasks: TaskListItem[]) => void
  /**
   * ⌘↵ on a selection (V1's `toggleChecked`): complete the open rows, or, when
   * every selected row is already checked, reopen them all.
   */
  toggle: (tasks: TaskListItem[]) => void
  remove: (tasks: TaskListItem[]) => void
  checkboxToggle: (task: TaskListItem) => void
  /** Buffer the text of an open editor; nothing is saved or re-rendered. */
  draft: (task: TaskListItem, text: string) => void
  /** Drop the buffered text without saving it. */
  discardDraft: (task: TaskListItem) => void
  /**
   * End an edit: save the buffered text when it changed, or delete an emptied
   * task. Returns the task as it now stands, or null when it was deleted.
   */
  commitDraft: (task: TaskListItem) => TaskListItem | null
  /** Add an empty placeholder to edit. Nothing is written until it has text. */
  insert: (target: InsertTaskTarget) => TaskListItem | null
  /**
   * Enter while editing (V1 continuous entry): save the current row, then add
   * the next task. A task with breadcrumb context is continued inside that
   * context; other tasks use the group's target.
   */
  insertAfter: (task: TaskListItem, target: InsertTaskTarget) => TaskListItem | null
  /** Set each task's due date to `isoDate`, or clear it when null (⌘⇧S, V1). */
  schedule: (tasks: TaskListItem[], isoDate: string | null) => void
  /** Drop each task's checkbox so the line stays in its note as a plain bullet (⌘⇧K). */
  convertToBullet: (tasks: TaskListItem[]) => void
  /** Archive (⌘⇧↵): stop showing the session's completed tasks in the active list. */
  archive: () => void
}

export function useTaskActions(): TaskActions {
  const { graph } = useGraph()
  const root = graph?.root ?? null
  const generation = graph?.generation
  const controller = useMemo(
    () => (root !== null && generation !== undefined ? taskController(root, generation) : null),
    [root, generation],
  )
  return useMemo((): TaskActions => {
    const current = (row: TaskListItem) => controller?.current(row) ?? row
    const change = (row: TaskListItem, edit: TaskChange) => {
      if (!controller) return
      const before = current(row)
      controller.submit(before, edit)
      if (edit.remove || edit.toBullet || edit.checked === false) {
        forgetRecentlyCompleted(root, [taskKey(before)])
      } else if (edit.checked === true) {
        markRecentlyCompleted(root, [current(before)])
      }
    }
    const toggle = (rows: TaskListItem[]) => {
      const checked = !rows.every((row) => current(row).checked)
      for (const row of rows) if (current(row).checked !== checked) change(row, { checked })
    }
    return {
      complete: (rows) => {
        for (const row of rows) if (!current(row).checked) change(row, { checked: true })
      },
      toggle,
      remove: (rows) => {
        for (const row of rows) change(row, { remove: true })
      },
      checkboxToggle: (row) => toggle([row]),
      draft: (row, text) => controller?.draft(row, text),
      discardDraft: (row) => controller?.discardDraft(row),
      commitDraft: (row) => (controller ? controller.commitDraft(row) : row),
      insert: (target) => controller?.begin({ ...target, breadcrumbs: [] }) ?? null,
      insertAfter: (row, target) => {
        if (!controller) return null
        const saved = controller.commitDraft(row)
        const contextual =
          saved !== null && saved.breadcrumbs.length > 0 && saved.text.trim() !== ''
        return controller.begin(
          { ...target, breadcrumbs: contextual ? saved.breadcrumbs : [] },
          contextual ? saved : undefined,
        )
      },
      schedule: (rows, isoDate) => {
        for (const row of rows) change(row, { dueDate: isoDate })
      },
      convertToBullet: (rows) => {
        for (const row of rows) change(row, { toBullet: true })
      },
      archive: () => archiveRecentlyCompleted(root),
    }
  }, [controller, root])
}
