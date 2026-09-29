import {
  compareTaskPaths,
  decodeTaskPath,
  inlineMarkdownToDisplayText,
  type TaskAddress,
} from '../markdown/index.ts'
import { db } from './db.ts'
import { decodeTaskBreadcrumbs } from './indexed-note.ts'

/** A projected task with its note context and derived display text. */
export interface OpenTask extends TaskAddress {
  /** Raw first-paragraph Markdown from the note, without the `[ ]` or `[x]` marker. */
  text: string
  checked: boolean
  /** Plain display/search text derived from `text`, never stored in SQLite. */
  displayText: string
  /** Ancestor list-item labels, outermost first, for task grouping and context. */
  breadcrumbs: readonly string[]
  noteTitle: string
  dueDate: string | null
  dailyDate: string | null
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt: number
}

async function getTasks(checked: boolean): Promise<OpenTask[]> {
  const rows = await db
    .selectFrom('tasks')
    .innerJoin('notes', 'notes.path', 'tasks.notePath')
    .where('notes.kind', '!=', 'template')
    .where('tasks.checked', '=', checked ? 1 : 0)
    .select([
      'tasks.astPath',
      'tasks.text',
      'tasks.notePath',
      'tasks.breadcrumbs',
      'tasks.dueDate',
      'notes.fileHash as revision',
      'notes.title as noteTitle',
      'notes.dailyDate',
      'notes.isPinned',
      'notes.pinnedOrder',
      'notes.updatedAt',
    ])
    .execute()
  return rows
    .map((row) => ({
      ...row,
      checked,
      astPath: decodeTaskPath(row.astPath),
      isPinned: row.isPinned !== 0,
      breadcrumbs: decodeTaskBreadcrumbs(row.breadcrumbs),
      displayText: inlineMarkdownToDisplayText(row.text),
    }))
    .sort(
      (left, right) =>
        (checked ? right.updatedAt - left.updatedAt : 0) ||
        left.notePath.localeCompare(right.notePath) ||
        compareTaskPaths(left.astPath, right.astPath),
    )
}

/** Open tasks across non-template notes. */
export function getOpenTasks(): Promise<OpenTask[]> {
  return getTasks(false)
}

/** Completed tasks, newest note first, then note path and document order. */
export function getCompletedTasks(): Promise<OpenTask[]> {
  return getTasks(true)
}
