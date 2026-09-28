import { useSyncExternalStore } from 'react'
import type { TaskAddress } from '@reflect/core'

interface FailedTaskDraft {
  key: string
  generation: number
  task: TaskAddress
  content: string
}
let drafts: readonly FailedTaskDraft[] = []
const listeners = new Set<() => void>()
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
/** Keep a failed edit available after its editor closes. */
export function keepTaskDraft(task: TaskAddress, content: string, generation: number): void {
  const key = JSON.stringify([generation, task.notePath, task.revision, task.astPath])
  drafts = [...drafts.filter((draft) => draft.key !== key), { key, generation, task, content }]
  for (const listener of listeners) listener()
}
export function dismissTaskDraft(key: string): void {
  drafts = drafts.filter((draft) => draft.key !== key)
  for (const listener of listeners) listener()
}
export function useFailedTaskDrafts(): readonly FailedTaskDraft[] {
  return useSyncExternalStore(subscribe, () => drafts)
}
