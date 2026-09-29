import {
  collectInlineElements,
  LEZER_NODE_IDS,
  parseInline,
  parseMarkdownAst,
  walkMarkdownAst,
  type MarkdownNode,
  type MarkdownDocument,
} from '@meowdown/markdown'
import type { ParsedTask } from './model.ts'
import { inlineMarkdownToDisplayText } from './plain-text.ts'
import { normalizeWikiTarget } from './resolve.ts'

export function getTaskParagraph(node: MarkdownNode) {
  if (node.type !== 'listItem' || node.kind !== 'task') return
  const paragraph = node.children[0]
  return paragraph?.type === 'paragraph' ? paragraph : undefined
}

/** Project round tasks outside quotes from the complete note body. */
export function projectTaskContext(body: string): {
  tasks: ParsedTask[]
} {
  return projectTaskDocument(parseMarkdownAst(body))
}

/** Extract round task rows from a parsed document. */
export function projectTaskDocument(document: MarkdownDocument): {
  tasks: ParsedTask[]
} {
  const contexts = new Map<MarkdownNode, { quoted: boolean; breadcrumbs: readonly string[] }>()
  const tasks: ParsedTask[] = []
  for (const { node, parent, path } of walkMarkdownAst(document)) {
    const context = parent && contexts.get(parent)
    const quoted = node.type === 'blockquote' || context?.quoted === true
    const breadcrumbs = context?.breadcrumbs ?? []
    if (node.type === 'listItem') {
      const paragraph = getTaskParagraph(node)
      if (!quoted && node.kind === 'task' && node.marker === '+' && paragraph) {
        const text = paragraph.value
        const dueDate =
          collectInlineElements(
            parseInline(text),
            (node) =>
              node.type === LEZER_NODE_IDS.Wikilink || node.type === LEZER_NODE_IDS.WikiEmbed,
          )
            .map((node) => {
              const start = node.from + (node.type === LEZER_NODE_IDS.WikiEmbed ? 3 : 2)
              const target = text.slice(start, node.to - 2).split('|')[0] ?? ''
              return normalizeWikiTarget(target).date
            })
            .find((date) => date !== undefined) ?? null
        tasks.push({
          astPath: path,
          text,
          checked: node.checked,
          dueDate,
          breadcrumbs,
        })
      }
      const first = node.children[0]
      const label = first?.type === 'paragraph' ? inlineMarkdownToDisplayText(first.value) : ''
      contexts.set(node, {
        quoted,
        breadcrumbs: label ? [...breadcrumbs, label] : breadcrumbs,
      })
    } else {
      contexts.set(node, { quoted, breadcrumbs })
    }
  }
  return { tasks }
}
