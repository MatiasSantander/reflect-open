import {
  parseMarkdownAst,
  resolveMarkdownAstPath,
  serializeMarkdownAst,
  walkMarkdownAst,
  type MarkdownBlock,
  type MarkdownListItem,
} from '@meowdown/markdown'
import { splitFrontmatter } from './frontmatter.ts'
import { getTaskParagraph, projectTaskDocument } from './task-projection.ts'
import { encodeTaskPath } from './task-path.ts'
import { protectTaskParagraph } from './task-paragraph.ts'

/** Structural changes applied atomically to one revision of a note. */
export interface TaskEdit {
  astPath: readonly number[]
  checked?: boolean | undefined
  /** Raw first-paragraph Markdown, without the checkbox marker. */
  text?: string | undefined
  remove?: boolean | undefined
  toBullet?: boolean | undefined
  insertAfter?: boolean | undefined
  insertText?: string | undefined
}

/** Edit a note's task nodes and serialize its entire body. */
export function editTaskDocument(
  source: string,
  edits: readonly TaskEdit[],
  append: boolean | string = false,
) {
  const { body, bodyOffset } = splitFrontmatter(source)
  const document = parseMarkdownAst(body)
  const originals = new Map<MarkdownListItem, readonly number[]>()
  for (const { node, path } of walkMarkdownAst(document)) {
    if (node.type === 'listItem' && getTaskParagraph(node)) originals.set(node, path)
  }
  const merged = new Map<string, TaskEdit>()
  for (const edit of edits) {
    const key = encodeTaskPath(edit.astPath)
    const previous = merged.get(key)
    if (
      previous &&
      (previous.remove ||
        edit.remove ||
        (previous.checked !== undefined &&
          edit.checked !== undefined &&
          previous.checked !== edit.checked) ||
        (previous.text !== undefined && edit.text !== undefined && previous.text !== edit.text))
    ) {
      throw new Error('Conflicting edits address the same task.')
    }
    merged.set(key, { ...previous, ...edit })
  }
  const targets = [...merged.values()].map((edit) => {
    const entry = resolveMarkdownAstPath(document, edit.astPath)
    const paragraph = entry && getTaskParagraph(entry.node)
    if (!entry || entry.node.type !== 'listItem' || !paragraph) {
      throw new Error('The task no longer exists. Refresh the task list.')
    }
    return { edit, item: entry.node, paragraph }
  })
  let changed = append !== false
  let created: MarkdownListItem | undefined
  const create = (text: string): MarkdownListItem => ({
    type: 'listItem',
    kind: 'task',
    checked: false,
    collapsed: false,
    marker: '+',
    children: [{ type: 'paragraph', value: text }],
  })
  for (const { edit, item, paragraph } of targets) {
    if (edit.text !== undefined && paragraph.value !== edit.text) {
      paragraph.value = edit.text
      changed = true
    }
    if (edit.checked !== undefined && item.checked !== edit.checked) {
      item.checked = edit.checked
      changed = true
    }
    if (edit.toBullet) {
      item.kind = 'bullet'
      item.checked = false
      item.collapsed = true
      item.marker = '+'
      changed = true
    }
    if (!edit.remove && (edit.text !== undefined || edit.toBullet)) {
      protectTaskParagraph(item)
    }
    if (edit.remove || edit.insertAfter) {
      // Earlier splices can change sibling indexes within this batch.
      const entry = [...walkMarkdownAst(document)].find((entry) => entry.node === item)
      const parent = entry?.parent
      if (
        !parent ||
        parent.type === 'table' ||
        parent.type === 'tableRow' ||
        !parent.children ||
        entry.index === undefined
      ) {
        throw new Error('Conflicting task edits. Refresh the task list.')
      }
      const replacements: MarkdownBlock[] = edit.remove ? item.children.slice(1) : [item]
      if (edit.insertAfter) {
        created = create(edit.insertText ?? '')
        replacements.push(created)
      }
      parent.children.splice(entry.index, 1, ...replacements)
      changed = true
    }
  }
  if (append !== false) {
    if (body === '') document.children = []
    created = create(typeof append === 'string' ? append : '')
    document.children.push(created)
  }
  const nextSource = changed ? source.slice(0, bodyOffset) + serializeMarkdownAst(document) : source
  const nextBody = splitFrontmatter(nextSource).body
  const reparsedDocument = parseMarkdownAst(nextBody)
  const mutatedEntries = [...walkMarkdownAst(document)]
  const mutatedPaths = new Map(mutatedEntries.map(({ node, path }) => [node, path]))
  // Check only paragraphs this operation edits, before the caller writes anything.
  for (const { edit, item } of targets) {
    if (edit.remove || (edit.text === undefined && !edit.toBullet)) continue
    const path = mutatedPaths.get(item)
    const saved = path && resolveMarkdownAstPath(reparsedDocument, path)?.node
    if (
      !saved ||
      saved.type !== 'listItem' ||
      saved.kind !== item.kind ||
      saved.children[0]?.type !== 'paragraph' ||
      item.children[0]?.type !== 'paragraph' ||
      saved.children[0].value !== item.children[0].value
    ) {
      throw new Error('The edited task paragraph cannot be preserved. Refresh the task list.')
    }
  }
  const finalTasks = projectTaskDocument(reparsedDocument).tasks
  const mutatedTasks = projectTaskDocument(document).tasks
  const sameTaskProjection = JSON.stringify(mutatedTasks) === JSON.stringify(finalTasks)
  const finalTaskPaths = new Set(finalTasks.map((task) => encodeTaskPath(task.astPath)))
  const paths = new Map<string, readonly number[]>()
  let createdPath: readonly number[] | undefined
  if (sameTaskProjection) {
    for (const [node, previous] of originals) {
      const path = mutatedPaths.get(node)
      if (path && finalTaskPaths.has(encodeTaskPath(path)))
        paths.set(encodeTaskPath(previous), path)
    }
    createdPath = created && mutatedPaths.get(created)
  }
  if (created && !createdPath) throw new Error('The new task could not be preserved.')
  return { source: nextSource, paths, createdPath, tasks: finalTasks }
}
