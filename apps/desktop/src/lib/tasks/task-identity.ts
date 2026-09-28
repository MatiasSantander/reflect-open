import { onTaskMutation } from '@/lib/note-task.ts'
import { encodeTaskPath, type TaskAddress } from '@reflect/core'

const identities = new Map<string, string>()
function addressKey(task: TaskAddress): string {
  return JSON.stringify([task.notePath, task.revision, task.astPath])
}
onTaskMutation((receipt) => {
  for (const [previous, astPath] of receipt.paths) {
    const oldKey = addressKey({
      notePath: receipt.notePath,
      revision: receipt.beforeRevision,
      astPath: JSON.parse(previous),
    })
    const nextKey = addressKey({ notePath: receipt.notePath, revision: receipt.revision, astPath })
    identities.set(nextKey, identities.get(oldKey) ?? oldKey)
  }
  while (identities.size > 2000) {
    const oldest = identities.keys().next().value
    if (oldest === undefined) break
    identities.delete(oldest)
  }
})

/** Revision scopes paths so cached rows never alias a different source revision. */
export function taskKey(task: TaskAddress): string {
  const key = addressKey(task)
  return identities.get(key) ?? key
}

/** Whether two rows address the same task in the same note revision. */
export function sameTask(left: TaskAddress, right: TaskAddress): boolean {
  return (
    left.notePath === right.notePath &&
    left.revision === right.revision &&
    encodeTaskPath(left.astPath) === encodeTaskPath(right.astPath)
  )
}
