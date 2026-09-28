import { encodeTaskPath, type TaskAddress } from '@reflect/core'

/** Revision scopes paths so cached rows never alias a different source revision. */
export function taskKey(task: TaskAddress): string {
  return JSON.stringify([task.notePath, task.revision, task.astPath])
}

/** Whether two rows address the same task in the same note revision. */
export function sameTask(left: TaskAddress, right: TaskAddress): boolean {
  return (
    left.notePath === right.notePath &&
    left.revision === right.revision &&
    encodeTaskPath(left.astPath) === encodeTaskPath(right.astPath)
  )
}
