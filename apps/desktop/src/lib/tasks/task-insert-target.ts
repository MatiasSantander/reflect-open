import type { OpenTask, TaskAddress } from '@reflect/core'

/**
 * The note a new task is added to (Return-to-add, V1): its path plus the context
 * the optimistic row needs to render and bucket before the reindex.
 */
export interface InsertTaskTarget {
  notePath: string
  noteTitle: string
  dailyDate: string | null
  isPinned: boolean
  pinnedOrder: number | null
}

/** Build the optimistic open row for a just-written empty task. */
export function insertedTaskRow(
  target: InsertTaskTarget,
  address: TaskAddress,
  breadcrumbs: readonly string[] = [],
): OpenTask {
  return {
    text: '',
    ...address,
    checked: false,
    displayText: '',
    breadcrumbs,
    noteTitle: target.noteTitle,
    dueDate: null,
    dailyDate: target.dailyDate,
    isPinned: target.isPinned,
    pinnedOrder: target.pinnedOrder,
    updatedAt: Date.now(),
  }
}
