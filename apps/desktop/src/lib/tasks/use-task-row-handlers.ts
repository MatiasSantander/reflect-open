import { useCallback } from 'react'
import type { Task, TaskStore } from '@reflect/core'
import type { TaskEditHandlers } from '@/components/tasks/task-editor.tsx'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import { continueFrom, previousTaskKey } from '@/lib/tasks/task-navigation.ts'

export interface TaskRowHandlerDeps {
  selection: ListSelection
  store: TaskStore | null
  /** The flat, render-order tasks, used to pick the row to select after a delete. */
  orderedTasks: readonly Task[]
  /** Today's ISO date: Enter adds the next task into the row's group (V1). */
  today: string
  /** Bring a row into view after a keyboard move (V1 scrolls the selection). */
  scrollToKey: (key: string | null) => void
}

/**
 * The inline editor's per-row callbacks (V1 parity): Enter saves the row and
 * opens the next task, ↑/↓ move between rows mid-edit, and Backspace on an
 * empty row deletes it and lands on the previous one. The store saves the
 * row's draft before any of these act on it.
 */
export function useTaskRowHandlers({
  selection,
  store,
  orderedTasks,
  today,
  scrollToKey,
}: TaskRowHandlerDeps): (task: Task) => TaskEditHandlers {
  const selectExclusively = useCallback(
    (key: string) => {
      selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
      scrollToKey(key)
    },
    [selection, scrollToKey],
  )

  return useCallback(
    (task: Task): TaskEditHandlers => ({
      onContinue: () => {
        const created = store && continueFrom(store, task, today)
        if (created) selectExclusively(created.key)
        else selection.clear()
      },
      onCancel: () => selection.clear(),
      onComplete: () => {
        // ⌘↵ on an already completed row saves the text but never reopens it.
        if (task.checked) store?.commitDraft(task)
        else store?.setChecked([task], true)
        selection.clear()
      },
      onConvertToBullet: () => {
        store?.convertToBullet([task])
        selection.clear()
      },
      onDelete: () => {
        store?.remove([task])
        selection.clear()
      },
      onDeleteEmpty: () => {
        const previous = previousTaskKey(orderedTasks, task)
        store?.remove([task])
        if (previous !== null) selectExclusively(previous)
        else selection.clear()
      },
      onNavigate: (direction, { span }) => {
        if (span) selection.extend(direction)
        else selection.move(direction)
        scrollToKey(selection.activeKey())
      },
    }),
    [store, selection, orderedTasks, today, selectExclusively, scrollToKey],
  )
}
