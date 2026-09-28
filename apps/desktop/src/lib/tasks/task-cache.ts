import { inlineMarkdownToDisplayText, type OpenTask } from '@reflect/core'
import { sameTask, taskKey } from '@/lib/tasks/task-identity.ts'

/**
 * Pure transforms over a cached task list ({@link OpenTask}[]), the optimistic
 * shapes the Tasks view applies before the reindex reconciles. Each takes the
 * current list (possibly `undefined` when a query isn't loaded) and returns the
 * next, leaving `undefined` untouched so a not-loaded completed list (archived
 * off) is a no-op. They identify rows by {@link sameTask}, the same key the
 * React rows and the mutations use, so an optimistic edit can't target the wrong
 * row. Kept apart from the mutation hooks so they're unit-testable directly and
 * shared by every Tasks write — single-row and bulk alike.
 */

/** Drop every row matching one of `tasks` from a cached list. */
export function withoutTasks(
  rows: OpenTask[] | undefined,
  tasks: OpenTask[],
): OpenTask[] | undefined {
  return rows?.filter((row) => !tasks.some((task) => sameTask(row, task)))
}

/**
 * Move `tasks` to the front of the completed list as checked, de-duping any
 * already present — the optimistic shape of completing them with archived on, so
 * the rows stay visible struck through instead of vanishing until the refetch.
 */
export function asCompleted(
  rows: OpenTask[] | undefined,
  tasks: OpenTask[],
): OpenTask[] | undefined {
  if (rows === undefined) {
    return rows
  }
  const kept = rows.filter((row) => !tasks.some((task) => sameTask(row, task)))
  return [...tasks.map((task) => ({ ...task, checked: true })), ...kept]
}

/**
 * Move `tasks` into the open list as unchecked, de-duping any already present.
 * The open-tasks query is the primary Tasks view data source, so a not-yet-loaded
 * list materializes as just the reopened rows.
 */
export function asOpen(rows: OpenTask[] | undefined, tasks: OpenTask[]): OpenTask[] {
  const reopened = tasks.map((task) => ({ ...task, checked: false }))
  const reopenedKeys = new Set(reopened.map(taskKey))
  return [...(rows ?? []).filter((row) => !reopenedKeys.has(taskKey(row))), ...reopened]
}

/** Update derived display text alongside editable Markdown. */
export function withEditedTask(
  rows: OpenTask[] | undefined,
  task: OpenTask,
  content: string,
): OpenTask[] | undefined {
  return rows?.map((row) =>
    sameTask(row, task)
      ? { ...row, firstParagraphMarkdown: content, text: inlineMarkdownToDisplayText(content) }
      : row,
  )
}
