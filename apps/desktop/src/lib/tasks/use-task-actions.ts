import { useMemo } from 'react'
import type { TaskListItem as OpenTask, TaskChange } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider.tsx'
import { taskController } from './task-controller.ts'
import {
  archiveRecentlyCompleted,
  markRecentlyCompleted,
  forgetRecentlyCompleted,
} from './recently-completed.ts'
import { taskKey } from './task-identity.ts'
import { scheduledContent } from './task-schedule-content.ts'
import type { InsertTaskTarget } from './task-insert-target.ts'

export interface TaskActions {
  complete: (tasks: OpenTask[]) => void
  /**
   * ⌘↵ on a selection (V1's `toggleChecked`): complete the open rows, or — when
   * every selected row is already checked — reopen them all. So a just-completed
   * row (still struck) can be un-done with the same chord.
   */
  toggle: (tasks: OpenTask[]) => void
  remove: (tasks: OpenTask[]) => void
  /** Replace one task's content from the inline editor (Plan 18). */
  edit: (task: OpenTask, content: string) => void
  /** Toggle one row checkbox with exact rollback semantics for inline-editor checkbox clicks. */
  checkboxToggle: (task: OpenTask) => void
  /**
   * Add a new empty task to `target`'s note (Return-to-add, V1) and return the
   * optimistic row to select — its inline editor opens focused. Resolves to
   * `null` when there's no graph or the write failed (the toast already fired).
   */
  insert: (target: InsertTaskTarget) => Promise<OpenTask | null>
  /**
   * Enter while editing (V1 continuous entry): persist the current row's edit
   * (when `content` isn't null), then add the next task in `target` and return it
   * to select. A task with breadcrumb context is continued structurally inside
   * that context; other tasks retain the V1 bucket-target behavior.
   */
  insertAfter: (
    task: OpenTask,
    content: string | null,
    target: InsertTaskTarget,
  ) => Promise<OpenTask | null>
  /**
   * Save the paragraph and checkbox state in one revision-checked write.
   */
  editAndToggle: (task: OpenTask, content: string) => void
  /**
   * Schedule a selection (⌘⇧S / the calendar, V1): set each task's due date to
   * `isoDate`, or clear it when `isoDate` is null. Written as a content edit that
   * adds/replaces the `[[YYYY-MM-DD]]` link the projection reads as the due date.
   */
  schedule: (tasks: OpenTask[], isoDate: string | null) => void
  /**
   * Convert a selection to plain bullets (⌘⇧K, V1's "Convert to checklist"
   * restated for markdown): strip each task's `[ ]`/`[x]` marker so it leaves
   * the Tasks view but stays in its note as an ordinary list item.
   */
  convertToBullet: (tasks: OpenTask[]) => void
  /**
   * Save the paragraph and convert the item in one revision-checked write.
   */
  editAndConvertToBullet: (task: OpenTask, content: string) => void
  /** Archive (⌘⇧↵): stop showing the session's completed tasks in the active list. */
  archive: () => void
  isPending: boolean
}

export function useTaskActions(): TaskActions {
  const { graph } = useGraph()
  const controller = useMemo(
    () => (graph ? taskController(graph.root, graph.generation) : null),
    [graph?.root, graph?.generation],
  )
  const change = (row: OpenTask, edit: TaskChange) => {
    if (!controller) return
    const current = controller.current(row)
    controller.submit(current, edit)
    const latest = controller.current(current)
    if (edit.remove || edit.toBullet || edit.checked === false) {
      forgetRecentlyCompleted(graph?.root ?? null, [taskKey(current)])
    } else if (edit.checked === true) {
      markRecentlyCompleted(graph?.root ?? null, [latest])
    }
  }
  const toggle = (rows: OpenTask[]) => {
    const checked = !rows.every((row) => controller?.current(row).checked ?? row.checked)
    for (const row of rows) change(row, { checked })
  }
  return {
    isPending: false,
    complete: (rows) => {
      for (const row of rows) change(row, { checked: true })
    },
    toggle,
    remove: (rows) => {
      for (const row of rows) change(row, { remove: true })
    },
    edit: (row, text) => change(row, text.trim() ? { text } : { remove: true }),
    checkboxToggle: (row) => toggle([row]),
    insert: async (target) => controller?.begin({ ...target, breadcrumbs: [] }) ?? null,
    insertAfter: async (row, content, target) => {
      if (!controller) return null
      if (content !== null) change(row, content.trim() ? { text: content } : { remove: true })
      else if (!row.revision && !row.text.trim()) change(row, { remove: true })
      const contextual =
        row.breadcrumbs.length > 0 && content !== '' && (content !== null || row.text.trim() !== '')
      return controller.begin(
        { ...target, breadcrumbs: contextual ? row.breadcrumbs : [] },
        contextual ? row : undefined,
      )
    },
    editAndToggle: (row, text) =>
      change(row, { text, checked: !(controller?.current(row).checked ?? row.checked) }),
    schedule: (rows, date) => {
      for (const row of rows)
        change(row, { text: scheduledContent(controller?.current(row) ?? row, date) })
    },
    convertToBullet: (rows) => {
      for (const row of rows) change(row, { toBullet: true })
    },
    editAndConvertToBullet: (row, text) => change(row, { text, toBullet: true }),
    archive: () => archiveRecentlyCompleted(graph?.root ?? null),
  }
}
