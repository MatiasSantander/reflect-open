import { useMemo } from 'react'
import type { Task, TaskStore } from '@reflect/core'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import { continueFrom, previousTaskKey } from '@/lib/tasks/task-navigation.ts'

/**
 * What the Tasks view does to tasks, whether the key came from the list or
 * from a row's inline editor (V1: navigation and entry are global). Each
 * command changes the store and then the selection: a row leaves edit mode
 * when its task is completed, converted, or removed, and continuous entry
 * selects the row it just added.
 */
export interface TaskCommands {
  /** Return or Enter: save `task`'s draft, add the next task, and select it. Without a task, add to today's daily. */
  continue: (task: Task | undefined) => void
  /** ⌘↵: complete the tasks, or reopen them all when every one is checked. Keeps the selection. */
  complete: (tasks: readonly Task[]) => void
  /** ⌘⌫: delete the tasks. */
  remove: (tasks: readonly Task[]) => void
  /** Backspace on an empty row: delete it and land on the previous row. */
  removeEmpty: (task: Task) => void
  /** ⌘⇧K: turn the tasks into plain bullets. */
  convert: (tasks: readonly Task[]) => void
  /** ⌘⇧S or the calendar: set or clear the tasks' due date. */
  schedule: (tasks: readonly Task[], isoDate: string | null) => void
  /** ↑ / ↓ (Shift to extend): move the selection. */
  navigate: (direction: -1 | 1, span: boolean) => void
  /** Escape: leave edit mode. */
  cancel: () => void
  /** ⌘⇧↵: stop showing the session's completed tasks. */
  archive: () => void
}

export function useTaskCommands({
  store,
  selection,
  orderedTasks,
  today,
  scrollToKey,
}: {
  store: TaskStore | null
  selection: ListSelection
  /** The flat, render-order tasks, used to pick the row to select after a delete. */
  orderedTasks: readonly Task[]
  today: string
  /** Bring a row into view after a keyboard move (V1 scrolls the selection). */
  scrollToKey: (key: string | null) => void
}): TaskCommands {
  return useMemo(() => {
    const selectOnly = (key: string | null) => {
      if (key === null) selection.clear()
      else {
        selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
        scrollToKey(key)
      }
    }
    return {
      continue: (task) => selectOnly((store && continueFrom(store, task, today))?.key ?? null),
      // The rows stay selected, so ⌘↵ again reopens them (V1).
      complete: (tasks) => store?.toggle(tasks),
      remove: (tasks) => {
        store?.remove(tasks)
        selection.clear()
      },
      removeEmpty: (task) => {
        const previous = previousTaskKey(orderedTasks, task)
        store?.remove([task])
        selectOnly(previous)
      },
      convert: (tasks) => {
        store?.convertToBullet(tasks)
        selection.clear()
      },
      schedule: (tasks, isoDate) => {
        store?.schedule(tasks, isoDate)
        selection.clear()
      },
      navigate: (direction, span) => {
        if (span) selection.extend(direction)
        else selection.move(direction)
        scrollToKey(selection.activeKey())
      },
      cancel: () => selection.clear(),
      archive: () => store?.archive(),
    }
  }, [store, selection, orderedTasks, today, scrollToKey])
}
