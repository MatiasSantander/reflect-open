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
