import { useMemo } from 'react'
import type { Task, TaskTarget } from '@reflect/core'
import { useTaskStore } from './task-store.ts'

/**
 * The task changes a screen can make, as V1's Tasks view defines them. Every
 * change goes to the graph's task store, which saves a draft still open on the
 * task first, so nothing here needs to know whether the task is being edited.
 */
export interface TaskActions {
  complete: (tasks: Task[]) => void
  /** ⌘↵ on a selection: complete the open rows, or reopen them all when every row is checked. */
  toggle: (tasks: Task[]) => void
  remove: (tasks: Task[]) => void
  checkboxToggle: (task: Task) => void
  /** Set each task's due date to `isoDate`, or clear it when null. */
  schedule: (tasks: Task[], isoDate: string | null) => void
  /** Drop each task's checkbox so the line stays in its note as a plain bullet. */
  convertToBullet: (tasks: Task[]) => void
  /** Stop showing the session's completed tasks in the active list. */
  archive: () => void
  /** Buffer the text of an open editor; nothing is saved or re-rendered. */
  draft: (task: Task, text: string) => void
  /** Drop the buffered text without saving it. */
  discardDraft: (task: Task) => void
  /** End an edit: save the buffered text when it changed, or delete an emptied task. */
  commitDraft: (task: Task) => Task | null
  /** Add an empty task to edit. Nothing is written until it has text. */
  insert: (target: TaskTarget) => Task | null
  /**
   * Enter while editing (V1 continuous entry): save the current row, then add
   * the next task. A task with breadcrumb context is continued inside that
   * context; other tasks use the group's target.
   */
  insertAfter: (task: Task, target: TaskTarget) => Task | null
}

export function useTaskActions(): TaskActions {
  const store = useTaskStore()
  return useMemo((): TaskActions => {
    const current = (task: Task) => store?.current(task) ?? task
    const complete = (tasks: Task[]) => {
      for (const task of tasks) if (!current(task).checked) store?.complete(task)
    }
    const toggle = (tasks: Task[]) => {
      if (tasks.every((task) => current(task).checked)) {
        for (const task of tasks) store?.update(task, { checked: false })
      } else {
        complete(tasks)
      }
    }
    return {
      complete,
      toggle,
      remove: (tasks) => {
        for (const task of tasks) store?.update(task, { removed: true })
      },
      checkboxToggle: (task) => toggle([task]),
      schedule: (tasks, isoDate) => {
        for (const task of tasks) store?.update(task, { dueDate: isoDate })
      },
      convertToBullet: (tasks) => {
        for (const task of tasks) store?.update(task, { bullet: true })
      },
      archive: () => store?.archive(),
      draft: (task, text) => store?.draft(task, text),
      discardDraft: (task) => store?.discardDraft(task),
      commitDraft: (task) => (store ? store.commitDraft(task) : task),
      insert: (target) => store?.create(target) ?? null,
      insertAfter: (task, target) => {
        if (!store) return null
        const saved = store.commitDraft(task)
        const contextual =
          saved !== null && saved.breadcrumbs.length > 0 && saved.text.trim() !== ''
        return store.create(
          { ...target, breadcrumbs: contextual ? saved.breadcrumbs : [] },
          contextual ? saved : undefined,
        )
      },
    }
  }, [store])
}
