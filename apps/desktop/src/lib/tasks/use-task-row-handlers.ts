import { useCallback } from 'react'
import type { TaskListItem } from '@reflect/core'
import type { TaskEditHandlers } from '@/components/tasks/task-editor.tsx'
import {
  insertTargetForBucket,
  insertTargetForTask,
  previousTaskKey,
} from '@/lib/tasks/task-navigation.ts'
import { taskKey } from '@/lib/tasks/task-identity.ts'
import type { TaskActions } from '@/lib/tasks/use-task-actions.ts'
import type { TaskSelection } from '@/lib/tasks/use-task-selection.ts'

export interface TaskRowHandlerDeps {
  selection: TaskSelection
  actions: TaskActions
  /** The flat, render-order tasks, used to pick the row to select after a delete. */
  orderedTasks: readonly TaskListItem[]
  /** Today's ISO date: Enter adds the next task into the row's group (V1). */
  today: string
  /** Bring a row into view after a keyboard move (V1 scrolls the selection). */
  scrollToKey: (key: string | null) => void
}

/**
 * The inline editor's per-row callbacks (Plan 18, V1 parity). This is where
 * V1's keyboard flow lives: Enter saves the row and opens the next task, ↑/↓
 * move between rows mid-edit, and Backspace on an empty row deletes it and
 * lands on the previous one. Every write goes through `actions`, which saves
 * the row's draft first.
 */
export function useTaskRowHandlers({
  selection,
  actions,
  orderedTasks,
  today,
  scrollToKey,
}: TaskRowHandlerDeps): (task: TaskListItem) => TaskEditHandlers {
  const selectExclusively = useCallback(
    (key: string) => {
      selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
      scrollToKey(key)
    },
    [selection, scrollToKey],
  )

  return useCallback(
    (task: TaskListItem): TaskEditHandlers => ({
      onContinue: () => {
        // Add the next task into the row's breadcrumb context when it has one,
        // otherwise into V1's Current/note bucket target. An aggregate Overdue
        // or Upcoming bucket spans many notes, so V1 cannot add there.
        const target =
          task.breadcrumbs.length > 0
            ? insertTargetForTask(task)
            : insertTargetForBucket(task, today)
        if (target === null) {
          actions.commitDraft(task)
          selection.clear()
          return
        }
        const created = actions.insertAfter(task, target)
        if (created !== null) {
          selectExclusively(taskKey(created))
        } else {
          selection.clear()
        }
      },
      onCancel: () => selection.clear(),
      onComplete: () => {
        // ⌘↵ on an already completed row saves the text but never reopens it.
        if (task.checked) {
          actions.commitDraft(task)
        } else {
          actions.complete([task])
        }
        selection.clear()
      },
      onConvertToBullet: () => {
        actions.convertToBullet([task])
        selection.clear()
      },
      onDelete: () => {
        actions.remove([task])
        selection.clear()
      },
      onDeleteEmpty: () => {
        const previous = previousTaskKey(orderedTasks, task)
        actions.remove([task])
        if (previous !== null) {
          selectExclusively(previous)
        } else {
          selection.clear()
        }
      },
      onNavigate: (direction, { span }) => {
        if (span) {
          selection.extend(direction)
        } else {
          selection.move(direction)
        }
        scrollToKey(selection.activeKey())
      },
    }),
    [actions, selection, orderedTasks, today, selectExclusively, scrollToKey],
  )
}
