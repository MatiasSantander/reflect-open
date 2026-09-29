import { parseMarkdownAst, resolveMarkdownAstPath, type MarkdownDocument } from '@meowdown/markdown'
import { isAppError } from '../errors.ts'
import { hashContent } from '../indexing/hash.ts'
import type { TaskListItem } from '../indexing/queries-tasks.ts'
import { clearTaskDueDate, setTaskDueDate } from '../markdown/edit.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { inlineMarkdownToDisplayText } from '../markdown/plain-text.ts'
import { taskDueDate } from '../markdown/task-due-date.ts'
import { editTaskDocument, type NewTask } from '../markdown/task-mutation.ts'
import { encodeTaskPath } from '../markdown/task-path.ts'
import { projectTaskDocument } from '../markdown/task-projection.ts'

/**
 * One change to a task. `dueDate` is rewritten into a `text` change once the
 * task has text; on an empty placeholder it is kept until the first text.
 */
export interface TaskChange {
  /** New first-paragraph Markdown, without the checkbox marker. */
  text?: string | undefined
  checked?: boolean | undefined
  /** `YYYY-MM-DD`, or null to clear the date. */
  dueDate?: string | null | undefined
  remove?: boolean | undefined
  /** Drop the checkbox and keep the line as a plain bullet. */
  toBullet?: boolean | undefined
}

/** A submitted change that has not been confirmed on disk yet. */
export interface TaskCommand {
  /** The stable id of the task it applies to. */
  id: string
  /** The row as the caller saw it; carries the note metadata a new row needs. */
  row: TaskListItem
  edit: TaskChange
  /** For a new task: the id of the task it is inserted after. */
  after?: string | undefined
}

/** What the controller needs from the host to read and write notes. */
export interface TaskControllerIO {
  /** The note's current source, or null when the file does not exist. */
  read: (path: string) => Promise<string | null>
  /**
   * Replace the note atomically; must fail when the note no longer equals
   * `before`. May return the source actually saved when the host normalizes it.
   */
  write: (path: string, before: string | null, source: string) => Promise<string | void>
  /** A note's pending changes could not be saved; `retry` resumes them. */
  failure: (path: string, error: unknown, retry: () => void) => void
  /** A note's pending changes are all on disk. */
  saved: (path: string) => void
}

/** A task's location and note metadata, without the fields a placeholder starts empty. */
export type NewTaskTarget = Omit<TaskListItem, 'text' | 'displayText' | 'checked' | 'dueDate' | 'updatedAt'>

/** Everything the controller tracks for one note. */
interface NoteState {
  /** The tasks of `source`, with stable ids. Null before the first read or write. */
  rows: TaskListItem[] | null
  /** The source `rows` came from (null: no file). Undefined before the first read. */
  source: string | null | undefined
  /** A row carrying the note's metadata, for tasks the index has not seen yet. */
  context: TaskListItem | null
  /** New tasks that have no text yet, by id. Never written to disk. */
  placeholders: Map<string, TaskListItem>
  /** For a placeholder: the id of the task it will be inserted after. */
  anchors: Map<string, string>
  /** Text typed into an open editor, by id, until the edit ends. */
  drafts: Map<string, string>
  /** Stable id of every (revision, path) address this controller has confirmed. */
  ids: Map<string, string>
  /** Changes waiting to be written, in submission order. */
  commands: TaskCommand[]
  /** The write loop, while one is running. */
  running: Promise<void> | null
  /** True after a failed write, until the host retries. */
  failed: boolean
}

/** Stable identity for indexed rows and local placeholders. */
export function taskListKey(task: TaskListItem): string {
  return task.taskId ?? addressKey(task.notePath, task.revision, task.astPath)
}

function addressKey(
  path: string,
  revision: string | undefined,
  astPath: readonly number[] | undefined,
): string {
  return JSON.stringify([path, revision, astPath])
}

/** The row as it will look once `edit` is saved. */
function changedRow(row: TaskListItem, edit: TaskChange): TaskListItem {
  const text = edit.text ?? row.text
  return {
    ...row,
    text,
    displayText: inlineMarkdownToDisplayText(text),
    checked: edit.checked ?? row.checked,
    dueDate:
      edit.dueDate !== undefined ? edit.dueDate : edit.text === undefined ? row.dueDate : taskDueDate(text),
  }
}

/** A task node without its checkbox state, to recognize it after an external edit. */
function fingerprint(row: TaskListItem, document: MarkdownDocument): string | undefined {
  if (!row.astPath) return
  const node = resolveMarkdownAstPath(document, row.astPath)?.node
  return JSON.stringify(node, (key, value: unknown) => (key === 'checked' ? undefined : value))
}

/**
 * Carry ids from `previous` (the tasks of `before`) over to `rows` (the tasks
 * of `after`) when a task moved but its content is unique on both sides.
 */
function relocate(
  before: string,
  after: string,
  previous: readonly TaskListItem[],
  rows: TaskListItem[],
): void {
  const beforeAst = parseMarkdownAst(splitFrontmatter(before).body)
  const afterAst = parseMarkdownAst(splitFrontmatter(after).body)
  for (const old of previous) {
    const signature = fingerprint(old, beforeAst)
    if (!signature) continue
    const matches = rows.filter((row) => fingerprint(row, afterAst) === signature)
    const sources = previous.filter((row) => fingerprint(row, beforeAst) === signature)
    if (matches.length === 1 && sources.length === 1) matches[0]!.taskId = taskListKey(old)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Owns every task change made outside a note's own editor: the Tasks view,
 * the mobile sheet, and backlink checkboxes. One instance serves one graph.
 *
 * ## Identity
 *
 * The index addresses a task by `(notePath, revision, astPath)`, which changes
 * with every save. The controller gives each task a stable `taskId` instead:
 * a random id for tasks created here, and the first address it saw for
 * indexed tasks. `ids` maps every later address of a confirmed task back to
 * that id, so rows arriving from the index or from backlinks resolve to the
 * same task the UI is already showing.
 *
 * ## Placeholders and drafts
 *
 * `begin` creates a placeholder: a row with an id but no text, kept in memory
 * only. Nothing is read or written for it until it gets text. Typing goes to
 * `draft`, which stores the text without notifying anyone, so a keystroke never
 * re-renders the list or touches the disk. `commitDraft` turns the draft into a
 * change when the edit ends; `submit` folds a pending draft in first, so a
 * checkbox click or a schedule during an edit acts on the typed text. An
 * emptied task, or an abandoned empty placeholder, is removed.
 *
 * ## Commands and writes
 *
 * `submit` appends a command to the note's queue and starts its write loop.
 * The loop reads the note, maps the queued commands onto the tasks it finds,
 * applies them all to the Markdown AST, writes once, and then confirms every
 * command it wrote. Commands submitted while a write runs wait in the queue
 * and go out with the next write. Notes never block each other. A conflicting
 * write (the note changed between read and write) is retried a few times; any
 * other failure stops the note's loop and reports through `io.failure`, whose
 * `retry` resumes it. Pending commands stay visible either way.
 *
 * ## Projection
 *
 * `project` overlays the controller's knowledge on rows read from the index:
 * for a tracked note it shows the tasks of the last source it read or wrote,
 * plus placeholders, plus the effect of every pending command. The index only
 * contributes note metadata (title, pin state) once it has caught up with the
 * confirmed revision. `reconcile` re-reads tracked notes after an index update
 * so external edits show, and `relocate` keeps ids stable across them when the
 * task's content is unambiguous.
 */
export class TaskController {
  private readonly notes = new Map<string, NoteState>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(private readonly io: TaskControllerIO) {}

  /** Listen for projection changes; pairs with `snapshot` for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A counter that changes whenever `project` would return something new. */
  readonly snapshot = (): number => this.version

  /** Resolve once every running write loop has drained or failed. */
  readonly flush = async (): Promise<void> => {
    await Promise.all(
      [...this.notes.values()].flatMap((state) => (state.running ? [state.running] : [])),
    )
  }

  /**
   * Create an empty placeholder for a new task and return it. With `after`, the
   * task will be inserted right below that task and sorted there in the list.
   */
  begin(target: NewTaskTarget, after?: TaskListItem): TaskListItem {
    const state = this.note(target.notePath)
    const row: TaskListItem = {
      ...target,
      taskId: crypto.randomUUID(),
      text: '',
      displayText: '',
      checked: false,
      dueDate: null,
      updatedAt: Date.now(),
    }
    if (after) {
      state.anchors.set(row.taskId!, this.identify(state, after).taskId!)
      const path = after.sortPath ?? after.astPath
      if (path?.length) row.sortPath = [...path, Number.MAX_SAFE_INTEGER]
    }
    state.context = row
    state.placeholders.set(row.taskId!, row)
    this.emit()
    return row
  }

  /** Remember the text of an open editor. Notifies nobody and writes nothing. */
  draft(row: TaskListItem, text: string): void {
    const state = this.note(row.notePath)
    state.drafts.set(this.identify(state, row).taskId!, text)
  }

  /** Forget the open editor's text without saving it. */
  discardDraft(row: TaskListItem): void {
    const state = this.note(row.notePath)
    state.drafts.delete(this.identify(state, row).taskId!)
  }

  /**
   * End an edit: save the draft when it changed the text, or remove the task
   * when it (or an untouched placeholder) is empty. Returns the task as it now
   * stands, or null when it was removed.
   */
  commitDraft(row: TaskListItem): TaskListItem | null {
    const state = this.note(row.notePath)
    const id = this.identify(state, row).taskId!
    const text = (state.drafts.get(id) ?? this.current(row).text).trim()
    state.drafts.delete(id)
    if (this.removing(state, id)) return null
    if (text === '') {
      this.enqueue(state, row, { remove: true })
      return null
    }
    if (text !== this.current(row).text.trim()) this.enqueue(state, row, { text })
    return this.current(row)
  }

  /** Apply a change to a task. A draft still open on it is saved first. */
  submit(row: TaskListItem, edit: TaskChange): void {
    const state = this.note(row.notePath)
    const id = this.identify(state, row).taskId!
    if (edit.remove) state.drafts.delete(id)
    else if (state.drafts.has(id) && this.commitDraft(row) === null) return
    if (this.removing(state, id)) return
    if (edit.dueDate !== undefined) {
      const text = this.current(row).text
      if (text.trim() !== '') {
        const { dueDate, ...rest } = edit
        edit = { ...rest, text: dueDate === null ? clearTaskDueDate(text) : setTaskDueDate(text, dueDate) }
      }
    }
    this.enqueue(state, row, edit)
  }

  /** The task as the UI should show it now, including pending changes. */
  current(row: TaskListItem): TaskListItem {
    const state = this.notes.get(row.notePath)
    if (!state) return row
    const id = this.identify(state, row).taskId
    return this.visible(state, [row]).find((candidate) => candidate.taskId === id) ?? row
  }

  /** Overlay tracked notes on rows read from the index, keeping only `checked` rows. */
  project(indexed: readonly TaskListItem[], checked: boolean): TaskListItem[] {
    const result = indexed.filter((row) => !this.notes.has(row.notePath))
    for (const [path, state] of this.notes) {
      const noteRows = indexed.filter((row) => row.notePath === path)
      // The index describes the note (title, pin state) reliably only once it
      // has indexed the revision this controller confirmed.
      const metadata = noteRows.find((row) => row.revision === state.rows?.[0]?.revision)
      for (const row of this.visible(state, noteRows)) {
        result.push(
          metadata
            ? {
                ...row,
                noteTitle: metadata.noteTitle,
                dailyDate: metadata.dailyDate,
                isPinned: metadata.isPinned,
                pinnedOrder: metadata.pinnedOrder,
                updatedAt: metadata.updatedAt,
              }
            : row,
        )
      }
    }
    return result.filter((row) => row.inTasksView !== false && row.checked === checked)
  }

  /** The rows of `recent` that are still checked, as they stand now. */
  projectRecent(recent: readonly TaskListItem[]): TaskListItem[] {
    return recent.flatMap((row) => {
      const state = this.notes.get(row.notePath)
      if (!state) return [row]
      const id = this.identify(state, row).taskId
      const latest = this.visible(state, [row]).find((candidate) => candidate.taskId === id)
      return latest?.checked ? [latest] : []
    })
  }

  /**
   * Re-read every tracked note that has nothing pending and adopt external
   * changes. Called after the index reports a change.
   */
  async reconcile(): Promise<void> {
    for (const [path, state] of this.notes) {
      const before = state.source
      const stale = () => state.source !== before || state.running || state.commands.length > 0
      if (before === undefined || stale()) continue
      try {
        const source = await this.io.read(path)
        if (source === before || stale()) continue
        const revision = await hashContent(source ?? '')
        if (stale()) continue
        const rows = this.resolveRows(state, path, source ?? '', revision, [])
        if (before !== null && state.rows) relocate(before, source ?? '', state.rows, rows)
        await this.adopt(state, path, source, rows)
      } catch (error) {
        this.io.failure(path, error, () => this.start(path, state))
      }
    }
  }

  private note(path: string): NoteState {
    let state = this.notes.get(path)
    if (!state) {
      state = {
        rows: null,
        source: undefined,
        context: null,
        placeholders: new Map(),
        anchors: new Map(),
        drafts: new Map(),
        ids: new Map(),
        commands: [],
        running: null,
        failed: false,
      }
      this.notes.set(path, state)
    }
    return state
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** Whether a pending command deletes the task or turns it into a bullet. */
  private removing(state: NoteState, id: string): boolean {
    return state.commands.some(
      (command) => command.id === id && (command.edit.remove || command.edit.toBullet),
    )
  }

  /** The row with its stable id filled in. */
  private identify(state: NoteState, row: TaskListItem): TaskListItem {
    if (row.taskId) return row
    const key = addressKey(row.notePath, row.revision, row.astPath)
    return { ...row, taskId: state.ids.get(key) ?? key }
  }

  /** The note's tasks as the UI should show them: confirmed rows, placeholders, pending changes. */
  private visible(state: NoteState, indexed: readonly TaskListItem[]): TaskListItem[] {
    let rows = (state.rows ?? indexed).map((row) => this.identify(state, row))
    for (const placeholder of state.placeholders.values()) {
      if (!rows.some((row) => row.taskId === placeholder.taskId)) rows.push(placeholder)
    }
    for (const command of state.commands) {
      if (command.edit.remove || command.edit.toBullet) {
        rows = rows.filter((row) => row.taskId !== command.id)
        continue
      }
      const index = rows.findIndex((row) => row.taskId === command.id)
      if (index >= 0) rows[index] = changedRow(rows[index]!, command.edit)
      else rows.push(changedRow({ ...command.row, taskId: command.id }, command.edit))
    }
    return rows
  }

  /** Queue a change. Changes to an empty placeholder stay local until it has text. */
  private enqueue(state: NoteState, row: TaskListItem, edit: TaskChange): void {
    const identified = this.identify(state, row)
    const id = identified.taskId!
    const placeholder = state.placeholders.get(id)
    const text = edit.text?.trim() ?? ''
    if (placeholder && !state.commands.some((command) => command.id === id)) {
      if (edit.remove || edit.text?.trim() === '' || (edit.toBullet && text === '')) {
        state.placeholders.delete(id)
        state.anchors.delete(id)
        this.emit()
        return
      }
      if (text === '') {
        state.placeholders.set(id, changedRow(placeholder, edit))
        this.emit()
        return
      }
    }
    if (placeholder?.dueDate && text !== '') {
      edit = { ...edit, text: setTaskDueDate(edit.text!, placeholder.dueDate) }
    }
    state.commands.push({
      id,
      row: placeholder ? { ...identified, checked: placeholder.checked } : identified,
      edit,
      ...(state.anchors.has(id) ? { after: state.anchors.get(id)! } : {}),
    })
    this.emit()
    this.start(row.notePath, state)
  }

  /** Run the note's write loop unless it is already running or waiting for a retry. */
  private start(path: string, state: NoteState): void {
    if (state.running || state.failed) return
    state.running = this.drain(path, state).finally(() => {
      state.running = null
      if (state.commands.length > 0 && !state.failed) this.start(path, state)
    })
  }

  /** Write the queued commands, one read-apply-write round per batch. */
  private async drain(path: string, state: NoteState): Promise<void> {
    let retries = 0
    while (state.commands.length > 0 && !state.failed) {
      const commands = state.commands.slice()
      try {
        const disk = await this.io.read(path)
        const revision = await hashContent(disk ?? '')
        let rows = this.resolveRows(state, path, disk ?? '', revision, commands)
        if (state.source !== undefined && state.source !== disk && state.rows) {
          relocate(state.source ?? '', disk ?? '', state.rows, rows)
        }
        state.source = disk
        state.rows = rows
        const applied = this.apply(disk ?? '', rows, revision, commands)
        let source = applied.source
        rows = applied.rows
        if (source !== (disk ?? '')) {
          const written = await this.write(path, disk, source)
          if (written !== undefined && written !== source) {
            const normalized = this.resolveRows(state, path, written, revision, commands)
            relocate(source, written, rows, normalized)
            rows = normalized
            source = written
          }
        }
        await this.adopt(state, path, source, rows)
        for (const command of commands) {
          if (command.edit.remove || command.edit.toBullet) state.placeholders.delete(command.id)
        }
        state.commands.splice(0, commands.length)
        retries = 0
        this.io.saved(path)
        this.emit()
      } catch (error) {
        if (isAppError(error) && error.kind === 'io' && retries < 2) {
          retries++
          await delay(retries === 1 ? 200 : 800)
          continue
        }
        state.failed = true
        this.io.failure(path, error, () => {
          state.failed = false
          this.start(path, state)
        })
        this.emit()
      }
    }
  }

  /** Write, treating a failure whose result is already on disk as success. */
  private async write(path: string, before: string | null, source: string): Promise<string | undefined> {
    try {
      return (await this.io.write(path, before, source)) ?? undefined
    } catch (error) {
      if ((await this.io.read(path)) === source) return undefined
      throw error
    }
  }

  /**
   * Apply `commands` to `source` in order. Each edit addresses its task by the
   * AST path the task currently has, so the rows are remapped after every edit.
   */
  private apply(
    source: string,
    rows: TaskListItem[],
    revision: string,
    commands: readonly TaskCommand[],
  ): { source: string; rows: TaskListItem[] } {
    for (const command of commands) {
      const row = rows.find((candidate) => candidate.taskId === command.id)
      const isNew = command.row.revision === undefined
      if (!row && !isNew) throw new Error('This task changed elsewhere. Your text is kept.')
      if (!row && command.edit.remove) continue
      const anchor = command.after
        ? rows.find((candidate) => candidate.taskId === command.after)
        : undefined
      if (!row && command.after && !anchor) {
        throw new Error('The task insertion position changed. Your text is kept.')
      }
      const created: NewTask = {
        text: command.edit.text ?? command.row.text,
        checked: command.edit.checked ?? command.row.checked,
        bullet: command.edit.toBullet === true,
      }
      const { dueDate: _dueDate, ...edit } = command.edit
      const result = row?.astPath
        ? editTaskDocument(source, [{ ...edit, astPath: row.astPath }])
        : anchor?.astPath
          ? editTaskDocument(source, [{ astPath: anchor.astPath, insertAfter: created }])
          : editTaskDocument(source, [], created)
      source = result.source
      const previousRows = rows
      rows = result.allTasks.map((task) => {
        const key = encodeTaskPath(task.astPath)
        const previous = previousRows.find(
          (candidate) =>
            candidate.astPath &&
            encodeTaskPath(result.paths.get(encodeTaskPath(candidate.astPath)) ?? []) === key,
        )
        return {
          ...command.row,
          ...task,
          inTasksView: result.tasks.some((projected) => encodeTaskPath(projected.astPath) === key),
          taskId: previous?.taskId ?? command.id,
          revision,
          displayText: inlineMarkdownToDisplayText(task.text),
        }
      })
    }
    return { source, rows }
  }

  /**
   * The tasks in `source`, keeping the ids of tasks this controller already
   * knows at the same address in this revision.
   */
  private resolveRows(
    state: NoteState,
    path: string,
    source: string,
    revision: string,
    commands: readonly TaskCommand[],
  ): TaskListItem[] {
    const document = parseMarkdownAst(splitFrontmatter(source).body)
    const inView = new Set(projectTaskDocument(document).map((task) => encodeTaskPath(task.astPath)))
    const context = commands[0]?.row ?? state.rows?.[0] ?? state.context
    if (!context) return []
    const base = { ...context }
    delete base.sortPath
    const known = [...(state.rows ?? []), ...commands.map((command) => command.row)]
    return projectTaskDocument(document, true).map((task) => {
      const key = encodeTaskPath(task.astPath)
      const old = known.find(
        (row) => row.revision === revision && row.astPath && encodeTaskPath(row.astPath) === key,
      )
      return {
        ...base,
        ...task,
        inTasksView: inView.has(key),
        revision,
        taskId: old ? this.identify(state, old).taskId! : addressKey(path, revision, task.astPath),
        displayText: inlineMarkdownToDisplayText(task.text),
      }
    })
  }

  /** Make `rows` (the tasks of `source`) the note's confirmed state. */
  private async adopt(
    state: NoteState,
    path: string,
    source: string | null,
    rows: TaskListItem[],
  ): Promise<void> {
    const revision = await hashContent(source ?? '')
    state.source = source
    state.rows = rows.map((row) => {
      const next = { ...row, revision }
      delete next.sortPath
      state.ids.set(addressKey(path, revision, next.astPath), next.taskId!)
      state.placeholders.delete(next.taskId!)
      return next
    })
    this.emit()
  }
}
