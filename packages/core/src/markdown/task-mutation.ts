import {
  applySourceEdits,
  planTaskInsertion,
  planTaskSourceEdits,
  type SourceEdit,
  type TaskSourceItem,
} from '@meowdown/markdown'
import { ReflectError } from '../errors.ts'
import { splitFrontmatter } from './frontmatter.ts'
import { parseBody } from './grammar.ts'
import { parseNote } from './extract.ts'
import { normalizeWikiTarget } from './resolve.ts'
import { scanInlineWikiLinks } from './scan.ts'
import { scanReflectTasks, type TaskRowSnapshot } from './task-snapshot.ts'

export interface TaskMutation {
  base: TaskRowSnapshot
  firstParagraphMarkdown?: string
  checked?: boolean
  dueDate?: string | null
  remove?: boolean
  toBullet?: boolean
  continue?: boolean
}

export interface TaskRelocation {
  before: TaskRowSnapshot
  after: TaskRowSnapshot | null
}

export interface TaskMutationPlan {
  source: string
  edits: readonly SourceEdit[]
  before: readonly TaskSourceItem[]
  removed: ReadonlySet<number>
}

function conflict(message: string): never {
  throw new ReflectError('revisionConflict', message)
}

/** A conservative single changed region; ambiguous external edits are refused. */
function changedRange(before: string, after: string) {
  let from = 0
  while (from < before.length && from < after.length && before[from] === after[from]) from++
  let beforeTo = before.length
  let afterTo = after.length
  while (beforeTo > from && afterTo > from && before[beforeTo - 1] === after[afterTo - 1]) {
    beforeTo--
    afterTo--
  }
  return { from, beforeTo, afterTo }
}

/** Keep complete physical lines together so shared checkbox prefixes cannot hide insertions. */
function changedLineRange(before: string, after: string) {
  const previous = before.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const current = after.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let first = 0
  let from = 0
  while (first < previous.length && first < current.length && previous[first] === current[first]) {
    from += previous[first]!.length
    first++
  }
  let oldEnd = previous.length
  let newEnd = current.length
  let beforeTo = before.length
  let afterTo = after.length
  while (oldEnd > first && newEnd > first && previous[oldEnd - 1] === current[newEnd - 1]) {
    beforeTo -= previous[--oldEnd]!.length
    afterTo -= current[--newEnd]!.length
  }
  return { from, beforeTo, afterTo }
}

/** Merge disjoint edits within a paragraph; never silently choose one overlapping edit. */
export function mergeTaskParagraph(base: string, current: string, draft: string): string {
  if (base === current || current === draft) return draft
  if (base === draft) return current
  const theirs = changedRange(base, current)
  const ours = changedRange(base, draft)
  if (ours.beforeTo < theirs.from || (ours.beforeTo === theirs.from && ours.from !== theirs.from)) {
    return (
      current.slice(0, ours.from) +
      draft.slice(ours.from, ours.afterTo) +
      current.slice(ours.beforeTo)
    )
  }
  if (theirs.beforeTo < ours.from || (theirs.beforeTo === ours.from && theirs.from !== ours.from)) {
    const delta = theirs.afterTo - theirs.beforeTo
    return (
      current.slice(0, ours.from + delta) +
      draft.slice(ours.from, ours.afterTo) +
      current.slice(ours.beforeTo + delta)
    )
  }
  return conflict('This task changed while you were editing. Your draft has been kept.')
}

/** Dates are inline wiki links, so code and later item blocks cannot be scheduled. */
export function scheduleTaskParagraph(markdown: string, date: string | null): string {
  if (date !== null && normalizeWikiTarget(date).date === undefined) {
    throw new Error('Expected a calendar date')
  }
  const dates = scanInlineWikiLinks(markdown).filter(
    (link) => normalizeWikiTarget(link.target).date !== undefined,
  )
  if (date !== null && dates.length === 0) return `${markdown.trimEnd()} [[${date}]]`.trimStart()
  const selected = date === null ? dates : dates.slice(0, 1)
  return applySourceEdits(
    markdown,
    selected.map((link) => ({
      range: { from: link.from, to: link.to },
      expected: markdown.slice(link.from, link.to),
      insert: date === null ? '' : `[[${date}]]`,
    })),
  ).trimEnd()
}

function indexTaskSources(items: readonly TaskSourceItem[]) {
  const byOffset = new Map(items.map((item) => [item.marker.from, item]))
  const counts = new Map<string, number>()
  for (const item of items)
    counts.set(item.firstParagraphMarkdown, (counts.get(item.firstParagraphMarkdown) ?? 0) + 1)
  return { items, byOffset, counts }
}

function locate(
  source: string,
  revision: string,
  current: ReturnType<typeof indexTaskSources>,
  bases: Map<string, ReturnType<typeof indexTaskSources>>,
  base: TaskRowSnapshot,
  readBase: (revision: string) => string | undefined,
): TaskSourceItem {
  let offset = base.anchor.markerOffset
  if (revision !== base.anchor.revision) {
    const previous = readBase(base.anchor.revision)
    if (previous === undefined)
      return conflict('This task needs to be refreshed before it can be changed.')
    let old = bases.get(previous)
    if (!old) {
      old = indexTaskSources(scanReflectTasks(previous))
      bases.set(previous, old)
    }
    const original = old.byOffset.get(offset)
    if (!original || original.firstParagraphMarkdown !== base.projection.firstParagraphMarkdown) {
      return conflict('The original task is no longer available.')
    }
    if (
      (old.counts.get(original.firstParagraphMarkdown) ?? 0) > 1 ||
      (current.counts.get(original.firstParagraphMarkdown) ?? 0) > 1
    )
      return conflict('Repeated tasks changed position. Refresh before retrying.')
    const change = changedLineRange(previous, source)
    if (change.beforeTo <= original.firstParagraphRemoval.from)
      offset += change.afterTo - change.beforeTo
    else if (change.from < original.firstParagraph.to) {
      const candidate = current.byOffset.get(offset)
      if (
        !candidate ||
        old.items.length !== current.items.length ||
        change.from < original.firstParagraphRemoval.from ||
        change.beforeTo > original.firstParagraphRemoval.to ||
        change.afterTo > candidate.firstParagraphRemoval.to ||
        candidate.firstParagraphRemoval.from !== original.firstParagraphRemoval.from
      ) {
        return conflict('The task moved or changed ambiguously. Your draft has been kept.')
      }
    }
  }
  const task = current.byOffset.get(offset)
  if (!task) return conflict('This task was removed or changed into another block.')
  if (
    revision === base.anchor.revision &&
    (task.markerText !== base.anchor.markerText ||
      task.firstParagraphMarkdown !== base.projection.firstParagraphMarkdown)
  )
    return conflict('The task no longer matches its source snapshot.')
  return task
}

/** Validate every target before applying any edit to the original source. */
export function planTaskMutations(
  source: string,
  revision: string,
  operations: readonly TaskMutation[],
  readBase: (revision: string) => string | undefined,
  append = false,
): TaskMutationPlan {
  const tasks = scanReflectTasks(source)
  const current = indexTaskSources(tasks)
  const bases = new Map<string, ReturnType<typeof indexTaskSources>>()
  const combined = new Map<number, { task: TaskSourceItem; operation: TaskMutation }>()
  for (const operation of operations) {
    const task = locate(source, revision, current, bases, operation.base, readBase)
    const previous = combined.get(task.marker.from)
    combined.set(task.marker.from, { task, operation: { ...previous?.operation, ...operation } })
  }
  const edits: SourceEdit[] = []
  const removed = new Set<number>()
  for (const { task, operation } of combined.values()) {
    if (operation.continue) {
      const { body, bodyOffset } = splitFrontmatter(source)
      let ancestor = parseBody(body).resolve(task.marker.from - bodyOffset, 1).parent
      while (ancestor && ancestor.name !== 'ListItem') ancestor = ancestor.parent
      ancestor = ancestor?.parent ?? null
      while (ancestor && ancestor.name !== 'ListItem') ancestor = ancestor.parent
      let end = ancestor ? ancestor.to + bodyOffset : task.item.to
      if (source[end - 1] === '\r') end--
      if (operation.remove) end = Math.max(end, task.firstParagraphRemoval.to)
      edits.push(
        planTaskInsertion(source, {
          target: { kind: 'position', offset: end, prefix: task.siblingPrefix },
        }),
      )
    }
    if (operation.remove) {
      removed.add(task.marker.from)
      edits.push(...planTaskSourceEdits(source, task, { kind: 'removeFirstParagraph' }))
      continue
    }
    let markdown =
      operation.firstParagraphMarkdown === undefined
        ? task.firstParagraphMarkdown
        : mergeTaskParagraph(
            operation.base.projection.firstParagraphMarkdown,
            task.firstParagraphMarkdown,
            operation.firstParagraphMarkdown,
          )
    if (operation.dueDate !== undefined)
      markdown = scheduleTaskParagraph(markdown, operation.dueDate)
    const paragraphEdits =
      markdown === task.firstParagraphMarkdown
        ? []
        : planTaskSourceEdits(source, task, {
            kind: 'replaceFirstParagraph',
            firstParagraphMarkdown: markdown,
          })
    if (operation.toBullet) {
      removed.add(task.marker.from)
      // Fold the overlapping checkbox separator and paragraph replacement into
      // one patch. The rest of the list item remains byte-for-byte untouched.
      if (paragraphEdits.length) {
        const replacement = paragraphEdits[0]!
        edits.push({
          range: { from: task.marker.from, to: replacement.range.to },
          expected: source.slice(task.marker.from, replacement.range.to),
          insert: replacement.insert.replace(/^ /, ''),
        })
      } else {
        edits.push(...planTaskSourceEdits(source, task, { kind: 'toBullet' }))
      }
    } else {
      edits.push(...paragraphEdits)
    }
    if (!operation.toBullet && operation.checked !== undefined) {
      edits.push(
        ...planTaskSourceEdits(source, task, { kind: 'setChecked', value: operation.checked }),
      )
    }
  }
  if (append) edits.push(planTaskInsertion(source))
  return { source: applySourceEdits(source, edits), edits, before: tasks, removed }
}

/** Known edits supply identity mapping; offsets are never matched by display text. */
export function mapTaskOffset(offset: number, edits: readonly SourceEdit[]): number {
  let mapped = offset
  for (const edit of edits) {
    if (edit.range.to <= offset && edit.range.from < offset)
      mapped += edit.insert.length - (edit.range.to - edit.range.from)
  }
  return mapped
}

export function projectTaskSnapshots(
  notePath: string,
  source: string,
  revision: string,
): TaskRowSnapshot[] {
  return parseNote({ path: notePath, source }).tasks.map((task) => ({
    anchor: { notePath, revision, markerOffset: task.markerOffset, markerText: task.markerText },
    projection: {
      firstParagraphMarkdown: task.firstParagraphMarkdown,
      plainText: task.plainText,
      checked: task.checked,
      dueDate: task.dueDate,
      breadcrumbs: task.breadcrumbs,
    },
  }))
}

/** Map a batch of original coordinates with one ordered sweep over the patches. */
export function mapTaskOffsets(
  offsets: readonly number[],
  edits: readonly SourceEdit[],
): Map<number, number> {
  const ordered = [...edits].sort((left, right) => left.range.to - right.range.to)
  const result = new Map<number, number>()
  let index = 0
  let delta = 0
  for (const offset of [...offsets].sort((left, right) => left - right)) {
    while (index < ordered.length) {
      const edit = ordered[index]!
      if (edit.range.to > offset || edit.range.from >= offset) break
      delta += edit.insert.length - (edit.range.to - edit.range.from)
      index++
    }
    result.set(offset, offset + delta)
  }
  return result
}
