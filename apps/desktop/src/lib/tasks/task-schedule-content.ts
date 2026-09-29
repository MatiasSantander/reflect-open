import { clearTaskDueDate, setTaskDueDate, type OpenTask } from '@reflect/core'

/** Return the task content after setting or clearing its scheduled date link. */
export function scheduledContent(task: OpenTask, isoDate: string | null): string {
  const content = task.text
  return isoDate === null ? clearTaskDueDate(content) : setTaskDueDate(content, isoDate)
}
