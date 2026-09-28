import { gfmParser, parseInline, type InlineElement } from '@meowdown/markdown'
import { unescapeMarkdownText } from './body-display-text.ts'
export { unescapeMarkdownText, buildPlainText } from './body-display-text.ts'

/** Render inline Markdown as a compact display string. */
export function inlineMarkdownToDisplayText(markdown: string): string {
  function render(
    nodes: readonly InlineElement[],
    from: number,
    to: number,
    literal = false,
    link = false,
  ): string {
    let result = ''
    let cursor = from
    const text = (value: string) => (literal ? value : unescapeMarkdownText(value))
    for (const node of nodes) {
      result += text(markdown.slice(cursor, node.from))
      const name = gfmParser.nodeSet.types[node.type]?.name ?? ''
      if (name === 'Wikilink' || name === 'WikiEmbed') {
        const inner = markdown.slice(node.from + (name === 'WikiEmbed' ? 3 : 2), node.to - 2)
        result += unescapeMarkdownText(
          inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner,
        )
      } else if (
        !name.endsWith('Mark') &&
        !(link && (name === 'URL' || name === 'LinkTitle' || name === 'LinkLabel'))
      ) {
        result +=
          node.children.length > 0
            ? render(
                node.children,
                node.from,
                node.to,
                literal || name === 'InlineCode',
                name === 'Link' || name === 'Image',
              )
            : text(markdown.slice(node.from, node.to))
      }
      cursor = node.to
    }
    return result + text(markdown.slice(cursor, to))
  }
  return render(parseInline(markdown), 0, markdown.length).replaceAll(/\s+/g, ' ').trim()
}
