import type { SyntaxNode } from '@meowdown/markdown'
import type { Span } from './model.ts'
import { plainTextOfRange } from './plain-text.ts'

/**
 * A task's breadcrumbs are the rendered labels of its ancestor `ListItem`
 * nodes, outermost first — the outline context the Tasks view shows above a
 * run of rows. Only list ancestry counts: headings and sibling items are not
 * context, and a parent task labels the subtasks nested beneath it. Each
 * label is the item's lead textblock (its first paragraph or task line)
 * rendered through the same plain-text pass as task text, so markdown
 * formatting is stripped consistently and wrapped lines stay one label.
 */

/** The textblock that labels a list item: its first non-marker child, if that
 * child is a paragraph or task line (a nested list can't label its parent). */
function listItemLeadTextblock(item: SyntaxNode): SyntaxNode | null {
  for (let child = item.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === 'ListMark') {
      continue
    }
    return child.name === 'Paragraph' || child.name === 'Task' ? child : null
  }
  return null
}

function listItemBreadcrumbLabel(
  body: string,
  item: SyntaxNode,
  cuts: Span[],
  literalRanges: Span[],
  readText = (from: number, to: number) => plainTextOfRange(body, from, to, cuts, literalRanges),
): string | null {
  const textblock = listItemLeadTextblock(item)
  if (textblock === null) {
    return null
  }
  const text = readText(textblock.from, textblock.to)
  return text === '' ? null : text
}

/** Collect a task's ancestor-list labels, outermost first. */
export function taskBreadcrumbs(
  body: string,
  taskNode: SyntaxNode,
  cuts: Span[],
  literalRanges: Span[],
  readText = (from: number, to: number) => plainTextOfRange(body, from, to, cuts, literalRanges),
  labels = new Map<number, string | null>(),
): string[] {
  const ownItem = taskNode.parent
  if (ownItem?.name !== 'ListItem') {
    return []
  }

  const breadcrumbs: string[] = []
  for (let ancestor = ownItem.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.name === 'ListItem') {
      if (!labels.has(ancestor.from)) {
        labels.set(
          ancestor.from,
          listItemBreadcrumbLabel(body, ancestor, cuts, literalRanges, readText),
        )
      }
      const text = labels.get(ancestor.from) ?? null
      if (text !== null) {
        breadcrumbs.push(text)
      }
    }
  }

  return breadcrumbs.reverse()
}
