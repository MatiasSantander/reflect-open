import { scanTaskItems, type SourceRange, type TaskSourceItem } from '@meowdown/markdown'
import { hashContent } from '../indexing/hash.ts'
import { splitFrontmatter } from './frontmatter.ts'
import { parseBody } from './grammar.ts'

/** A coordinate is valid only within the exact source revision that produced it. */
export interface SourceAnchor {
  notePath: string
  revision: string
  markerOffset: number
  markerText: string
}

export interface TaskRanges {
  marker: SourceRange
  firstParagraph: SourceRange
  firstParagraphRemoval: SourceRange
  item: SourceRange
}

export interface TaskProjection {
  firstParagraphMarkdown: string
  plainText: string
  checked: boolean
  dueDate: string | null
  breadcrumbs: readonly string[]
}

export interface TaskRowSnapshot {
  anchor: SourceAnchor
  projection: TaskProjection
}

export interface TaskSnapshot extends TaskRowSnapshot {
  ranges: TaskRanges
}

/** Reflect aggregates round checkboxes outside quotes; Meowdown owns their syntax. */
export function scanReflectTasks(source: string): TaskSourceItem[] {
  const { body, bodyOffset } = splitFrontmatter(source)
  const shift = (range: SourceRange): SourceRange => ({
    from: range.from + bodyOffset,
    to: range.to + bodyOffset,
  })
  return scanTaskItems(body, parseBody(body))
    .filter((task) => {
      const lineStart = body.lastIndexOf('\n', task.marker.from - 1) + 1
      return /^[\t ]*\+[\t ]+$/.test(body.slice(lineStart, task.marker.from))
    })
    .map((task) => ({
      ...task,
      marker: shift(task.marker),
      firstParagraph: shift(task.firstParagraph),
      firstParagraphRemoval: shift(task.firstParagraphRemoval),
      item: shift(task.item),
      contentFrom: task.contentFrom + bodyOffset,
    }))
}

/** Never hydrate coordinates using text from a different revision. */
export async function hydrateTask(
  row: TaskRowSnapshot,
  source: string,
): Promise<TaskSnapshot | null> {
  if (row.anchor.revision !== (await hashContent(source))) return null
  const task = scanReflectTasks(source).find((item) => item.marker.from === row.anchor.markerOffset)
  if (
    !task ||
    task.markerText !== row.anchor.markerText ||
    task.firstParagraphMarkdown !== row.projection.firstParagraphMarkdown
  )
    return null
  return {
    ...row,
    ranges: {
      marker: task.marker,
      firstParagraph: task.firstParagraph,
      firstParagraphRemoval: task.firstParagraphRemoval,
      item: task.item,
    },
  }
}
