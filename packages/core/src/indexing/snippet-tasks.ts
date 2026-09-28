import { parseMarkdownAst, walkMarkdownAst } from '@meowdown/markdown'
import { parseBody } from '../markdown/grammar.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import type { TaskAddress } from '../markdown/task-path.ts'

/** A rendered checkbox and, when available, its exact source revision address. */
export interface SnippetTask {
  checked: boolean
  round: boolean
  text: string
  address?: TaskAddress
}
export interface SnippetTaskSource {
  content: string
  notePath: string
  revision: string
  lineOrigins: readonly number[]
}

/** Enumerate snippet checkboxes and map their source positions to AST addresses. */
export function extractSnippetTasks(snippet: string, source?: SnippetTaskSource): SnippetTask[] {
  const addresses = new Map<number, TaskAddress>()
  if (source) {
    const { body, bodyOffset } = splitFrontmatter(source.content)
    const entries = [...walkMarkdownAst(parseMarkdownAst(body))].filter(
      ({ node }) => node.type === 'listItem' && node.kind === 'task',
    )
    let index = 0
    parseBody(body).iterate({
      enter: ({ name, from, node }) => {
        if (name !== 'Task' || node.parent?.parent?.name !== 'BulletList') return
        const entry = entries[index++]
        if (entry)
          addresses.set(from + bodyOffset, {
            notePath: source.notePath,
            revision: source.revision,
            astPath: entry.path,
          })
      },
    })
  }
  const tasks: SnippetTask[] = []
  parseBody(snippet).iterate({
    enter: ({ name, from, node }) => {
      if (name !== 'Task' || node.parent?.parent?.name !== 'BulletList') return
      const lineStart = snippet.lastIndexOf('\n', from - 1) + 1
      const end = snippet.indexOf('\n', from)
      const line = snippet.slice(from, end === -1 ? snippet.length : end)
      const lineIndex = snippet.slice(0, lineStart).split('\n').length - 1
      const origin = source?.lineOrigins[lineIndex]
      const address = origin === undefined ? undefined : addresses.get(origin + from - lineStart)
      tasks.push({
        checked: /^\[x\]/i.test(line),
        round: /^[\t ]*\+[\t ]+$/.test(snippet.slice(lineStart, from)),
        text: line.slice(line[3] === ' ' ? 4 : 3),
        ...(address ? { address } : {}),
      })
    },
  })
  return tasks
}
