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

/** A list item to create: its paragraph text and marker. */
export interface NewTask {
  text: string
  checked?: boolean | undefined
  /** Create a plain `+` bullet instead of a checkbox. */
  bullet?: boolean | undefined
}

/** Structural changes applied atomically to one revision of a note. */
export interface TaskEdit {
  astPath: readonly number[]
  checked?: boolean | undefined
  /** Raw first-paragraph Markdown, without the checkbox marker. */
  text?: string | undefined
  remove?: boolean | undefined
  toBullet?: boolean | undefined
  /** A new item to place right after this one. */
  insertAfter?: NewTask | undefined
}

function createItem(task: NewTask): MarkdownListItem {
  const item: MarkdownListItem = {
    type: 'listItem',
    kind: task.bullet ? 'bullet' : 'task',
    checked: task.bullet ? false : (task.checked ?? false),
    collapsed: task.bullet === true,
    marker: '+',
    children: [{ type: 'paragraph', value: task.text }],
  }
  protectTaskParagraph(item)
  return item
}

/**
 * Edit a note's task nodes and serialize its entire body. `append` adds a new
 * item at the end of the document. Returns the new source, a map from each
 * surviving task's old AST path to its new one, the created item's path, and
 * the projected tasks (round tasks outside quotes, then every checkbox).
 */
export function editTaskDocument(source: string, edits: readonly TaskEdit[], append?: NewTask) {
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
  let changed = append !== undefined
  let created: MarkdownListItem | undefined
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
      // Splices made for earlier edits in this batch shift sibling indexes, so
      // the parent and index are looked up again rather than taken from the
      // initial path resolution.
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
        created = createItem(edit.insertAfter)
        replacements.push(created)
      }
      parent.children.splice(entry.index, 1, ...replacements)
      changed = true
    }
  }
  if (append !== undefined) {
    if (body === '') document.children = []
    created = createItem(append)
    document.children.push(created)
  }
  const nextSource = changed ? source.slice(0, bodyOffset) + serializeMarkdownAst(document) : source
  const reparsedDocument = parseMarkdownAst(splitFrontmatter(nextSource).body)
  const mutatedPaths = new Map([...walkMarkdownAst(document)].map(({ node, path }) => [node, path]))
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
  const tasks = projectTaskDocument(reparsedDocument)
  const allTasks = projectTaskDocument(reparsedDocument, true)
  const mutatedTasks = projectTaskDocument(document, true)
  // Old paths map to new ones only when the serialized document reads back
  // with the task structure the in-memory mutation produced.
  const sameTaskProjection = JSON.stringify(mutatedTasks) === JSON.stringify(allTasks)
  const finalTaskPaths = new Set(allTasks.map((task) => encodeTaskPath(task.astPath)))
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
  return { source: nextSource, paths, createdPath, tasks, allTasks }
}
