import {
  getTaskParagraph,
  parseMarkdownAst,
  walkMarkdownAst,
  type MarkdownNode,
} from '@meowdown/markdown'
import type { ParsedTask } from './model.ts'
import { parseBody } from './grammar.ts'
import { markdownPlainText } from './plain-text.ts'
import { normalizeWikiTarget } from './resolve.ts'
import { scanInlineWikiLinks } from './scan.ts'

/** Project round tasks outside quotes from the complete note body. */
export function projectTaskContext(body: string): {
  tasks: ParsedTask[]
  referenceMarkdown: string
} {
  const definitions: string[] = []
  const document = parseMarkdownAst(body.replaceAll(/\r\n?/g, '\n'))
  const contexts = new Map<MarkdownNode, { quoted: boolean; breadcrumbs: readonly string[] }>()
  const tasks: ParsedTask[] = []
  for (const { node, parent, path } of walkMarkdownAst(document)) {
    if (node.type === 'paragraph') {
      parseBody(node.value).iterate({
        enter: ({ name, from, to }) => {
          if (name === 'LinkReference') definitions.push(node.value.slice(from, to))
        },
      })
    }
    const context = parent && contexts.get(parent)
    const quoted = node.type === 'blockquote' || context?.quoted === true
    const breadcrumbs = context?.breadcrumbs ?? []
    if (node.type === 'listItem') {
      const paragraph = getTaskParagraph(node)
      if (!quoted && node.kind === 'task' && node.marker === '+' && paragraph) {
        const firstParagraphMarkdown = paragraph.value
        const dueDate =
          scanInlineWikiLinks(firstParagraphMarkdown)
            .map((link) => normalizeWikiTarget(link.target).date)
            .find((date) => date !== undefined) ?? null
        tasks.push({
          astPath: path,
          firstParagraphMarkdown,
          checked: node.checked,
          dueDate,
          breadcrumbs,
        })
      }
      const first = node.children[0]
      const label = first?.type === 'paragraph' ? markdownPlainText(first.value) : ''
      contexts.set(node, { quoted, breadcrumbs: label ? [...breadcrumbs, label] : breadcrumbs })
    } else {
      contexts.set(node, { quoted, breadcrumbs })
    }
  }
  return { tasks, referenceMarkdown: definitions.join('\n\n') }
}
