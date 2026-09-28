import type { OpenTask } from '@reflect/core'

/** An indexed task with defaults for UI tests. */
export function makeOpenTask(overrides: Partial<OpenTask> = {}): OpenTask {
  const text = overrides.text ?? 'do it'
  const checked = overrides.checked ?? false
  return {
    firstParagraphMarkdown: text,
    revision: 'test-revision',
    referenceMarkdown: '',
    notePath: 'notes/n.md',
    astPath: [0],
    checked,
    text,
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
