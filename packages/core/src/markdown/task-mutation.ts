import {
  parseMarkdownAst,
  resolveMarkdownAstPath,
  serializeMarkdownAst,
  walkMarkdownAst,
  type MarkdownBlock,
  type MarkdownListItem,
} from '@meowdown/markdown'
import { splitFrontmatter } from './frontmatter.ts'
import { getTaskParagraph, projectTaskContext, projectTaskDocument } from './task-projection.ts'
import { encodeTaskPath } from './task-path.ts'

/** Structural changes applied atomically to one revision of a note. */
export interface TaskEdit {
  astPath: readonly number[]
  checked?: boolean
  firstParagraphMarkdown?: string
  remove?: boolean
  toBullet?: boolean
  insertAfter?: boolean
}

/** Edit a note's task nodes and serialize its entire body. */
export function editTaskDocument(source: string, edits: readonly TaskEdit[], append = false) {
  const { body, bodyOffset } = splitFrontmatter(source)
  const document = parseMarkdownAst(body)
  const originals = new Map<MarkdownListItem, readonly number[]>()
  for (const { node, path } of walkMarkdownAst(document)) {
    if (getTaskParagraph(node) && node.type === 'listItem') originals.set(node, path)
  }
  const targets = edits.map((edit) => {
    const entry = resolveMarkdownAstPath(document, edit.astPath)
    if (!entry || entry.node.type !== 'listItem' || !getTaskParagraph(entry.node)) {
      throw new Error('The task no longer exists. Refresh the task list.')
    }
    return { edit, item: entry.node }
  })
  let changed = append
  let created: MarkdownListItem | undefined
  const create = (): MarkdownListItem => ({
    type: 'listItem',
    kind: 'task',
    checked: false,
    collapsed: false,
    marker: '+',
    children: [{ type: 'paragraph', value: '' }],
  })
  for (const { edit, item } of targets) {
    const paragraph = getTaskParagraph(item)
    if (!paragraph) throw new Error('This task cannot be edited as a paragraph.')
    if (
      edit.firstParagraphMarkdown !== undefined &&
      paragraph.value !== edit.firstParagraphMarkdown
    ) {
      paragraph.value = edit.firstParagraphMarkdown
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
    if (edit.remove || edit.insertAfter) {
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
        created = create()
        replacements.push(created)
      }
      parent.children.splice(entry.index, 1, ...replacements)
      changed = true
    }
  }
  if (append) {
    if (body === '') document.children = []
    created = create()
    document.children.push(created)
  }
  const nextSource = changed ? source.slice(0, bodyOffset) + serializeMarkdownAst(document) : source
  const nextBody = splitFrontmatter(nextSource).body
  const finalTasks = projectTaskContext(nextBody).tasks
  const expectedTasks = projectTaskDocument(document).tasks
  const sameTaskProjection = JSON.stringify(expectedTasks) === JSON.stringify(finalTasks)
  const nodes = [...walkMarkdownAst(document)].filter(
    ({ node }) =>
      node.type === 'listItem' &&
      node.kind === 'task' &&
      node.marker === '+' &&
      getTaskParagraph(node),
  )
  const paths = new Map<string, readonly number[]>()
  let createdPath: readonly number[] | undefined
  // Pair only structurally unchanged addresses with the reparsed output.
  for (const { node, path } of sameTaskProjection ? nodes : []) {
    const task = finalTasks.find((task) => encodeTaskPath(task.astPath) === encodeTaskPath(path))
    const paragraph = getTaskParagraph(node)
    if (
      !task ||
      !paragraph ||
      task.firstParagraphMarkdown !== paragraph.value ||
      node.type !== 'listItem' ||
      task.checked !== node.checked
    )
      continue
    const previous = originals.get(node)
    if (previous) paths.set(encodeTaskPath(previous), path)
    if (node === created) createdPath = path
  }
  return { source: nextSource, paths, createdPath, tasks: finalTasks }
}
