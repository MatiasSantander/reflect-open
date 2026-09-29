import { isAppError } from '../errors.ts'
import { parseMarkdownAst, resolveMarkdownAstPath } from '@meowdown/markdown'
import { editTaskDocument, type TaskEdit } from '../markdown/task-mutation.ts'
import { hashContent } from '../indexing/hash.ts'
import type { TaskListItem } from '../indexing/queries-tasks.ts'
import { inlineMarkdownToDisplayText } from '../markdown/plain-text.ts'
import { projectTaskContext, projectTaskDocument } from '../markdown/task-projection.ts'
import { setTaskDueDate } from '../markdown/edit.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { encodeTaskPath } from '../markdown/task-path.ts'

export type TaskChange = Omit<TaskEdit, 'astPath' | 'insertAfter' | 'insertText'> & {
  dueDate?: string | null | undefined
}
export interface TaskCommand {
  id: string
  row: TaskListItem
  edit: TaskChange
  after?: string | undefined
}
export interface TaskAttempt {
  before: string | null
  source: string
  commands: readonly TaskCommand[]
}
export interface TaskControllerIO {
  ready?: () => Promise<void>
  read: (path: string) => Promise<string | null>
  write: (path: string, before: string | null, source: string) => Promise<string | void>
  checkpoint: (
    path: string,
    commands: readonly TaskCommand[],
    attempt: TaskAttempt | null,
  ) => Promise<void>
  failure: (path: string, error: unknown, retry: () => void) => void
  saved: (path: string) => void
}
interface NoteState {
  rows: TaskListItem[] | null
  context: TaskListItem | null
  commands: TaskCommand[]
  placeholders: Map<string, TaskListItem>
  anchors: Map<string, string>
  aliases: Map<string, string>
  source: string | null | undefined
  running: Promise<void> | null
  failed: boolean
  attempt: TaskAttempt | null
  retries: number
}

/** Stable identity for indexed rows and local placeholders. */
export function taskListKey(task: TaskListItem): string {
  return task.taskId ?? JSON.stringify([task.notePath, task.revision, task.astPath])
}

function changedRow(row: TaskListItem, edit: TaskChange): TaskListItem {
  const text = edit.text ?? row.text
  const projected = projectTaskContext(`+ [ ] ${text}\n`).tasks[0]
  return {
    ...row,
    text,
    displayText: inlineMarkdownToDisplayText(text),
    checked: edit.checked ?? row.checked,
    dueDate:
      edit.dueDate !== undefined
        ? edit.dueDate
        : edit.text === undefined
          ? row.dueDate
          : (projected?.dueDate ?? null),
  }
}

/** Owns task identities and serializes confirmed edit intents per note. */
export function createTaskController(io: TaskControllerIO) {
  const notes = new Map<string, NoteState>()
  const listeners = new Set<() => void>()
  let version = 0
  const emit = () => {
    version++
    for (const listener of listeners) listener()
  }
  function note(path: string): NoteState {
    let state = notes.get(path)
    if (!state) {
      state = {
        rows: null,
        context: null,
        commands: [],
        placeholders: new Map(),
        anchors: new Map(),
        aliases: new Map(),
        source: undefined,
        running: null,
        failed: false,
        attempt: null,
        retries: 0,
      }
      notes.set(path, state)
    }
    return state
  }
  function identify(state: NoteState, row: TaskListItem): TaskListItem {
    const key = taskListKey(row)
    return { ...row, taskId: state.aliases.get(key) ?? key }
  }
  function visible(state: NoteState, indexed: readonly TaskListItem[]): TaskListItem[] {
    let rows = (state.rows ?? indexed).map((row) => identify(state, row))
    for (const placeholder of state.placeholders.values()) {
      if (!rows.some((row) => taskListKey(row) === taskListKey(placeholder))) rows.push(placeholder)
    }
    for (const command of state.commands) {
      const index = rows.findIndex((row) => taskListKey(row) === command.id)
      if (command.edit.remove || command.edit.toBullet) {
        rows = rows.filter((row) => taskListKey(row) !== command.id)
      } else if (index >= 0) {
        rows[index] = changedRow(rows[index]!, command.edit)
      } else {
        rows.push(changedRow({ ...command.row, taskId: command.id }, command.edit))
      }
    }
    return rows
  }
  function begin(
    target: Omit<TaskListItem, 'text' | 'displayText' | 'checked' | 'dueDate' | 'updatedAt'>,
    after?: TaskListItem,
  ): TaskListItem {
    const state = note(target.notePath)
    const taskId = crypto.randomUUID()
    const row: TaskListItem = {
      ...target,
      taskId,
      text: '',
      displayText: '',
      checked: false,
      dueDate: null,
      updatedAt: Date.now(),
    }
    if (after) {
      const anchor = identify(state, after)
      state.anchors.set(taskId, taskListKey(anchor))
      const path = after.sortPath ?? after.astPath
      if (path?.length) row.sortPath = [...path, Number.MAX_SAFE_INTEGER]
    }
    state.context = row
    state.placeholders.set(taskId, row)
    emit()
    return row
  }
  function submit(row: TaskListItem, edit: TaskChange): void {
    const state = note(row.notePath)
    state.context = row
    const identified = identify(state, row)
    const id = taskListKey(identified)
    const placeholder = state.placeholders.get(id)
    if (
      placeholder &&
      !state.commands.some((command) => command.id === id) &&
      !state.rows?.some((saved) => taskListKey(saved) === id)
    ) {
      if (edit.remove || edit.text?.trim() === '' || (edit.toBullet && !edit.text?.trim())) {
        state.placeholders.delete(id)
        state.anchors.delete(id)
        emit()
        return
      }
      if (!edit.text?.trim()) {
        state.placeholders.set(id, changedRow(placeholder, edit))
        emit()
        return
      }
    }
    if (placeholder?.dueDate && edit.text?.trim())
      edit = { ...edit, text: setTaskDueDate(edit.text, placeholder.dueDate) }
    state.commands.push({
      id,
      row: placeholder ? { ...identified, checked: placeholder.checked } : identified,
      edit,
      ...(state.anchors.has(id) ? { after: state.anchors.get(id)! } : {}),
    })
    emit()
    void Promise.resolve()
      .then(async () => {
        await io.ready?.()
        await io.checkpoint(row.notePath, state.commands.slice(), state.attempt)
      })
      .catch((error: unknown) => {
        state.failed = true
        io.failure(row.notePath, error, () => {
          state.failed = false
          start(row.notePath, state)
        })
      })
    start(row.notePath, state)
  }
  function resolveRows(
    state: NoteState,
    source: string,
    revision: string,
    commands: readonly TaskCommand[],
  ): TaskListItem[] {
    const document = parseMarkdownAst(splitFrontmatter(source).body)
    const aggregate = new Set(
      projectTaskDocument(document).tasks.map((task) => encodeTaskPath(task.astPath)),
    )
    const tasks = projectTaskDocument(document, true).tasks
    const context = commands[0]?.row ?? state.rows?.[0] ?? state.context
    if (!context) return []
    return tasks.map((task) => {
      const old =
        state.rows?.find(
          (row) =>
            row.revision === revision &&
            row.astPath &&
            encodeTaskPath(row.astPath) === encodeTaskPath(task.astPath),
        ) ??
        commands
          .map((command) => command.row)
          .find(
            (row) =>
              row.revision === revision &&
              row.astPath &&
              encodeTaskPath(row.astPath) === encodeTaskPath(task.astPath),
          )
      const row = {
        ...context,
        ...task,
        inTasksView: aggregate.has(encodeTaskPath(task.astPath)),
        revision,
        taskId: old
          ? taskListKey(identify(state, old))
          : JSON.stringify([context.notePath, revision, task.astPath]),
        displayText: inlineMarkdownToDisplayText(task.text),
      }
      delete row.sortPath
      return row
    })
  }
  function relocate(
    before: string,
    after: string,
    previous: readonly TaskListItem[],
    rows: TaskListItem[],
  ): void {
    const beforeAst = parseMarkdownAst(splitFrontmatter(before).body)
    const afterAst = parseMarkdownAst(splitFrontmatter(after).body)
    const signature = (row: TaskListItem, ast: typeof beforeAst) =>
      row.astPath
        ? JSON.stringify(resolveMarkdownAstPath(ast, row.astPath)?.node, (key, value: unknown) =>
            key === 'checked' ? undefined : value,
          )
        : undefined
    for (const old of previous) {
      const fingerprint = signature(old, beforeAst)
      if (!fingerprint) continue
      const matches = rows.filter((row) => signature(row, afterAst) === fingerprint)
      if (
        matches.length === 1 &&
        previous.filter((row) => signature(row, beforeAst) === fingerprint).length === 1
      ) {
        matches[0]!.taskId = taskListKey(old)
      }
    }
  }
  async function drain(path: string, state: NoteState): Promise<void> {
    await io.ready?.()
    while (state.commands.length > 0 && !state.failed) {
      const commands = state.commands.slice()
      try {
        const actual = await io.read(path)
        if (
          state.attempt &&
          actual !== state.attempt.before &&
          actual !== state.attempt.source &&
          state.attempt.commands.some((command) => command.row.revision === undefined)
        ) {
          throw new Error(
            'The note changed during an uncertain save. Your draft is kept without adding a duplicate.',
          )
        }
        const disk =
          state.attempt && actual === state.attempt.source ? state.attempt.before : actual
        const revision = await hashContent(disk ?? '')
        let rows = resolveRows(state, disk ?? '', revision, commands)
        if (state.source != null && state.source !== disk && state.rows) {
          relocate(state.source, disk ?? '', state.rows, rows)
        }
        state.source = disk
        state.rows = rows
        let source = disk ?? ''
        for (const command of commands) {
          let row = rows.find((candidate) => taskListKey(candidate) === command.id)
          const isNew = state.placeholders.has(command.id) && command.row.revision === undefined
          if (!row && !isNew) throw new Error('This task changed elsewhere. Your text is kept.')
          if (!row && command.edit.remove) continue
          const anchor = command.after
            ? rows.find((candidate) => taskListKey(candidate) === command.after)
            : undefined
          if (!row && command.after && !anchor)
            throw new Error('The task insertion position changed. Your text is kept.')
          const result = row?.astPath
            ? editTaskDocument(source, [{ ...command.edit, astPath: row.astPath }])
            : anchor?.astPath
              ? editTaskDocument(source, [
                  {
                    astPath: anchor.astPath,
                    insertAfter: true,
                    insertText: command.edit.text ?? command.row.text,
                  },
                ])
              : editTaskDocument(source, [], command.edit.text ?? command.row.text)
          const previousRows = rows
          rows = result.allTasks.map((task) => {
            const previous = previousRows.find(
              (candidate) =>
                candidate.astPath &&
                encodeTaskPath(result.paths.get(encodeTaskPath(candidate.astPath)) ?? []) ===
                  encodeTaskPath(task.astPath),
            )
            const id = previous ? taskListKey(previous) : command.id
            return {
              ...command.row,
              ...task,
              inTasksView: result.tasks.some(
                (projected) => encodeTaskPath(projected.astPath) === encodeTaskPath(task.astPath),
              ),
              taskId: id,
              revision,
              displayText: inlineMarkdownToDisplayText(task.text),
            }
          })
          if (
            !row &&
            (command.edit.checked !== undefined || command.row.checked || command.edit.toBullet)
          ) {
            row = rows.find((candidate) => taskListKey(candidate) === command.id)
            if (row?.astPath) {
              const checked = editTaskDocument(result.source, [
                {
                  astPath: row.astPath,
                  checked: command.edit.checked ?? command.row.checked,
                  ...(command.edit.toBullet ? { toBullet: true } : {}),
                },
              ])
              source = checked.source
              rows = command.edit.toBullet
                ? rows.filter((candidate) => candidate !== row)
                : rows.map((candidate) =>
                    candidate === row
                      ? { ...candidate, checked: command.edit.checked ?? command.row.checked }
                      : candidate,
                  )
            } else source = result.source
          } else source = result.source
        }
        const attempt = { before: disk, source, commands }
        state.attempt = attempt
        await io.checkpoint(path, state.commands, attempt)
        try {
          const written = source === actual ? undefined : await io.write(path, actual, source)
          if (written !== undefined && written !== source) {
            const normalized = resolveRows(state, written, revision, commands)
            relocate(source, written, rows, normalized)
            rows = normalized
            source = written
          }
        } catch (error) {
          const actual = await io.read(path)
          if (actual !== source) throw error
        }
        const nextRevision = await hashContent(source)
        state.source = source
        state.rows = rows.map((row) => {
          const next = { ...row, revision: nextRevision }
          delete next.sortPath
          state.aliases.set(JSON.stringify([path, nextRevision, next.astPath]), taskListKey(next))
          state.placeholders.delete(taskListKey(next))
          return next
        })
        for (const command of commands)
          if (command.edit.remove || command.edit.toBullet) state.placeholders.delete(command.id)
        state.commands.splice(0, commands.length)
        state.attempt = null
        state.retries = 0
        state.failed = false
        await io.checkpoint(path, state.commands, null)
        io.saved(path)
        emit()
      } catch (error) {
        if (isAppError(error) && error.kind === 'io' && state.retries < 2) {
          state.retries++
          await new Promise((resolve) => setTimeout(resolve, state.retries === 1 ? 200 : 800))
          continue
        }
        state.failed = true
        io.failure(path, error, () => {
          state.failed = false
          start(path, state)
        })
        emit()
      }
    }
  }
  function start(path: string, state: NoteState): void {
    if (state.running || state.failed) return
    state.running = Promise.resolve()
      .then(() => drain(path, state))
      .finally(() => {
        state.running = null
        if (state.commands.length > 0 && !state.failed) start(path, state)
      })
  }
  return {
    begin,
    submit,
    restore(path: string, commands: readonly TaskCommand[], attempt: TaskAttempt | null): void {
      const state = note(path)
      state.commands.unshift(...commands)
      state.attempt = attempt
      for (const command of commands) {
        if (!command.row.revision) state.placeholders.set(command.id, command.row)
      }
      emit()
      start(path, state)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => version,
    /** Overlay whole-note confirmations and pending intents on index reads. */
    project(indexed: readonly TaskListItem[], checked: boolean): TaskListItem[] {
      const result = indexed.filter((row) => !notes.has(row.notePath))
      for (const [path, state] of notes) {
        const noteRows = indexed.filter((row) => row.notePath === path)
        result.push(...visible(state, noteRows))
      }
      return result.filter((row) => row.inTasksView !== false && row.checked === checked)
    },
    /** Verify tracked notes after an index notification, including empty projections. */
    async reconcile(): Promise<void> {
      for (const [path, state] of notes) {
        if (state.source === undefined || state.running || state.commands.length > 0) continue
        const before = state.source
        try {
          const source = await io.read(path)
          if (
            source === before ||
            state.source !== before ||
            state.running ||
            state.commands.length > 0
          )
            continue
          const revision = await hashContent(source ?? '')
          if (state.source !== before || state.running || state.commands.length > 0) continue
          const rows = resolveRows(state, source ?? '', revision, [])
          if (before !== null && state.rows) relocate(before, source ?? '', state.rows, rows)
          state.rows = rows
          state.source = source
          for (const row of rows)
            state.aliases.set(JSON.stringify([path, revision, row.astPath]), taskListKey(row))
          emit()
        } catch (error) {
          io.failure(path, error, () => {
            state.failed = false
            start(path, state)
          })
        }
      }
    },
    projectRecent(recent: readonly TaskListItem[]): TaskListItem[] {
      return recent.flatMap((row) => {
        const state = notes.get(row.notePath)
        if (!state) return [row]
        return visible(state, [row]).filter(
          (candidate) =>
            candidate.checked && taskListKey(candidate) === taskListKey(identify(state, row)),
        )
      })
    },
    current(row: TaskListItem): TaskListItem {
      const state = notes.get(row.notePath)
      return state
        ? (visible(state, [row]).find(
            (candidate) => taskListKey(candidate) === taskListKey(identify(state, row)),
          ) ?? row)
        : row
    },
    async flush(): Promise<void> {
      await io.ready?.()
      await Promise.all(
        [...notes.values()].flatMap((state) => (state.running ? [state.running] : [])),
      )
    },
  }
}
