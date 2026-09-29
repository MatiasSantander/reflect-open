import type { TaskListItem } from '@reflect/core'
import { useTaskActions } from './use-task-actions.ts'

/** Route row checkboxes through the shared task controller. */
export function useTaskCheckboxAction(): {
  toggle: (task: TaskListItem) => void
  isPending: boolean
} {
  const actions = useTaskActions()
  return { toggle: actions.checkboxToggle, isPending: false }
}
