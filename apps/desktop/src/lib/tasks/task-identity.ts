import { taskListKey, type TaskListItem } from '@reflect/core'

/** Stable task identity, including unsaved placeholders. */
export const taskKey = taskListKey

/** Compare logical rows rather than revision-scoped addresses. */
export function sameTask(left: TaskListItem, right: TaskListItem): boolean {
  return taskKey(left) === taskKey(right)
}
