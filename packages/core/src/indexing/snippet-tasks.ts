import { parseBody } from '../markdown/grammar.ts'
import { parseTaskMarker } from '../markdown/task-marker.ts'

/** Display metadata for a rendered snippet checkbox; not a note address. */
export interface SnippetTask {
  checked: boolean
  round: boolean
  text: string
}

/** Enumerate rendered bullet checkboxes, including read-only square checklists. */
export function extractSnippetTasks(
  snippet: string,
  _lineOrigins: readonly number[],
  _lineSourceTexts: readonly string[] = [],
): SnippetTask[] {
  const tasks: SnippetTask[] = []
  parseBody(snippet).iterate({
    enter: ({ name, from, node }) => {
      if (name !== 'Task' || node.parent?.parent?.name !== 'BulletList') return
      const lineStart = snippet.lastIndexOf('\n', from - 1) + 1
      const end = snippet.indexOf('\n', from)
      const line = snippet.slice(from, end === -1 ? snippet.length : end)
      tasks.push({
        checked: parseTaskMarker(line.slice(0, 3))?.checked === true,
        round: /^[\t ]*\+[\t ]+$/.test(snippet.slice(lineStart, from)),
        text: line.slice(line[3] === ' ' ? 4 : 3),
      })
    },
  })
  return tasks
}
