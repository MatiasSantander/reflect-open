import { inlineMarkdownToDisplayText, type TaskListItem } from '@reflect/core'

/** An indexed task with defaults for UI tests. */
export function makeOpenTask(overrides: Partial<TaskListItem> = {}): TaskListItem {
  const text = overrides.text ?? overrides.displayText ?? 'do it'
  const checked = overrides.checked ?? false
  return {
    text,
    revision: 'test-revision',
    notePath: 'notes/n.md',
    astPath: [0],
    checked,
    displayText: inlineMarkdownToDisplayText(text),
    breadcrumbs: [],
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}
