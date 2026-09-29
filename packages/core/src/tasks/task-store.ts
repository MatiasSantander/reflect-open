import { parseMarkdownAst } from '@meowdown/markdown'
import { isAppError } from '../errors.ts'
import { clearTaskDueDate, setTaskDueDate } from '../markdown/edit.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import type { ParsedTask } from '../markdown/model.ts'
import { inlineMarkdownToDisplayText } from '../markdown/plain-text.ts'
import { taskDueDate } from '../markdown/task-due-date.ts'
import { editTaskDocument } from '../markdown/task-mutation.ts'
import { encodeTaskPath } from '../markdown/task-path.ts'
import { projectTaskDocument } from '../markdown/task-projection.ts'

/** A task as the Tasks surfaces show it. Index rows and tasks created locally share this shape. */
export interface Task {
  /** Stable identity: `notePath#astPath` for an indexed task, a random id for one created here. */
  key: string
  notePath: string
  /**
   * Child indexes from the note body's AST root. For a task created here it is
   * provisional (just after the task it follows, or at the end) until written.
   */
  astPath: readonly number[]
  /** Raw first-paragraph Markdown, without the `[ ]` or `[x]` marker. */
  text: string
  /** Plain display text derived from `text`. */
  displayText: string
  checked: boolean
  dueDate: string | null
  /** Ancestor list-item labels, outermost first. */
  breadcrumbs: readonly string[]
  noteTitle: string
  dailyDate: string | null
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt: number
}

/** What a task should become. `dueDate` rewrites the text's `[[YYYY-MM-DD]]` link. */
export interface TaskPatch {
  text?: string | undefined
  checked?: boolean | undefined
  dueDate?: string | null | undefined
  removed?: true | undefined
  /** Drop the checkbox and keep the line as a plain bullet. */
  bullet?: true | undefined
}

/** What the store needs from the host to read and write notes. */
export interface TaskStoreIO {
  /** The note's current source, or null when the file does not exist. */
  read: (path: string) => Promise<string | null>
  /**
   * Replace the note atomically; must fail when the note no longer equals
   * `before`. Resolves once the index and the task queries reflect the write.
   */
  write: (path: string, before: string | null, source: string) => Promise<void>
  /** A note's changes could not be saved; `retry` tries again. */
  failure: (path: string, error: unknown, retry: () => void) => void
  /** A note's changes are all on disk. */
  saved: (path: string) => void
}

/** The note a new task goes into, with the metadata its row shows before the index has it. */
export type TaskTarget = Pick<
  Task,
  'notePath' | 'noteTitle' | 'dailyDate' | 'isPinned' | 'pinnedOrder'
> & { breadcrumbs?: readonly string[] | undefined }

/** Where a task was last seen in its note. */
interface Location {
  path: readonly number[]
  text: string
}

/** Everything the store knows about one task beyond the index. */
interface Entry {
  /** Where the task is in the note, remapped after every own write. Null until a task created here is written. */
  at: Location | null
  /** True for a task created here, whose key is not an index key. */
  created: boolean
  /** The task as it should be. A new object on every change. */
  row: Task
  /** The `row` the last write saved. The entry is pending while it differs from `row`. */
  saved: Task | null
  /** The task should leave the note as a checkbox. */
  gone?: 'removed' | 'bullet' | undefined
  /** For a task created here: the task it is inserted after. */
  after?: Task | undefined
  /** Text typed into an open editor, until the edit ends. */
  draft?: string | undefined
  /** Completed here; stays listed, struck, until archived. */
  recent?: boolean | undefined
  /** The note cannot take this change as it stands; cleared by a retry. */
  error?: unknown
}

interface Note {
  running: Promise<void> | null
  /** True after a failed read or write, until the host retries. */
  failed: boolean
}

/** The key of an indexed task. */
export function indexedTaskKey(notePath: string, astPath: readonly number[]): string {
  return `${notePath}#${encodeTaskPath(astPath)}`
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return encodeTaskPath(left) === encodeTaskPath(right)
}

/** `task` with `patch` applied. A date set on an empty task waits in `dueDate` for its first text. */
function patched(task: Task, patch: TaskPatch): Task {
  let text = patch.text ?? task.text
  if (patch.dueDate !== undefined && text.trim() !== '') {
    text = patch.dueDate === null ? clearTaskDueDate(text) : setTaskDueDate(text, patch.dueDate)
  }
  if (patch.text !== undefined && task.text.trim() === '' && task.dueDate && !taskDueDate(text)) {
    text = setTaskDueDate(text, task.dueDate)
  }
  return {
    ...task,
    text,
    displayText: inlineMarkdownToDisplayText(text),
    checked: patch.checked ?? task.checked,
    dueDate: text.trim() === '' ? (patch.dueDate ?? task.dueDate) : taskDueDate(text),
  }
}

/** The task at `location`, or the only task with its text when it moved. */
function find(tasks: readonly ParsedTask[], location: Location): ParsedTask | undefined {
  const atPath = tasks.find(
    (task) => samePath(task.astPath, location.path) && task.text === location.text,
  )
  if (atPath) return atPath
  const byText = tasks.filter((task) => task.text === location.text)
  return byText.length === 1 ? byText[0] : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Every task change made outside a note's own editor goes through here: the
 * Tasks view, the mobile sheet, and backlink checkboxes. One instance serves
 * one graph.
 *
 * The index is the read model. The store keeps one `Entry` per task it knows
 * more about than the index: the task as it should be (`row`), what the last
 * write saved (`saved`; the entry is pending while the two differ), and where
 * the task sits in its note (`at`), which every own write remaps. `list`
 * overlays pending rows on the index rows; `update` changes a task's row and
 * schedules its note; the note's write loop reads the file, makes every
 * pending task look like its row, writes once, and marks the rows it wrote as
 * saved. `io.write` resolves only after the index and the task queries
 * reflect the write, so an entry is only forgotten once the index shows it.
 *
 * A task created here has a random key and no location until written; the
 * entry then maps the index row at that location back to the key the UI
 * holds. Typing goes to `draft`, which stores text without notifying anyone;
 * `commitDraft` turns it into an update when the edit ends, and `update` folds
 * a pending draft in first, so a checkbox click during an edit acts on the
 * typed text. An emptied task, or an abandoned empty new task, is removed; an
 * empty new task is never written.
 *
 * Tasks completed through `complete` stay listed, struck, until `archive`
 * (V1's middle state). A change the note cannot take (its task is gone or
 * ambiguous) is reported once and waits, without blocking the note's other
 * changes; a failed read or write pauses the whole note until retried.
 */
export class TaskStore {
  private readonly entries = new Map<string, Entry>()
  private readonly notes = new Map<string, Note>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(private readonly io: TaskStoreIO) {}

  /** Listen for changes to what `list` returns; pairs with `snapshot` for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A counter that changes whenever `list` would return something new. */
  readonly snapshot = (): number => this.version

  /** Resolve once no write loop is running. */
  readonly flush = async (): Promise<void> => {
    for (;;) {
      const running = [...this.notes.values()].flatMap((note) =>
        note.running ? [note.running] : [],
      )
      if (running.length === 0) return
      await Promise.all(running)
    }
  }

  /**
   * The tasks to show: the open index rows, this session's completed tasks
   * (struck, until archived), the completed history when `completed` is given,
   * all with pending changes applied.
   */
  list(open: readonly Task[], completed?: readonly Task[]): Task[] {
    const rows = new Map<string, Task>()
    for (const task of this.rekey(open)) rows.set(task.key, task)
    for (const task of this.rekey(completed ?? [])) rows.set(task.key, task)
    for (const [key, entry] of this.entries) {
      if (entry.gone) {
        rows.delete(key)
        continue
      }
      const base = rows.get(key) ?? (entry.created || entry.recent ? entry.row : undefined)
      if (!base) continue
      const { text, displayText, checked, dueDate } = entry.row
      rows.set(
        key,
        entry.row === entry.saved ? base : { ...base, text, displayText, checked, dueDate },
      )
    }
    return [...rows.values()].filter(
      (task) => !task.checked || completed !== undefined || this.entries.get(task.key)?.recent,
    )
  }

  /** Complete a task from the list. It stays listed, struck, until `archive`. */
  complete(task: Task): void {
    this.update(task, { checked: true })
    const entry = this.entries.get(task.key)
    if (entry?.row.checked) entry.recent = true
  }

  /** Whether a task was completed in this session and is still listed struck. */
  isRecent(task: Task): boolean {
    const entry = this.entries.get(task.key)
    return entry?.recent === true && entry.row.checked
  }

  /** Stop listing this session's completed tasks. They stay `[x]` on disk. */
  archive(): void {
    for (const [key, entry] of this.entries) {
      entry.recent = false
      if (this.done(entry)) this.entries.delete(key)
    }
    this.emit()
  }

  /** The task as it should be now, including changes not written yet. */
  current(task: Task): Task {
    return this.entries.get(task.key)?.row ?? task
  }

  /**
   * Create an empty task and return it. With `after`, the task is inserted
   * right below that task and sorted there. Nothing is written until it has text.
   */
  create(target: TaskTarget, after?: Task): Task {
    const row: Task = {
      ...target,
      breadcrumbs: target.breadcrumbs ?? [],
      key: crypto.randomUUID(),
      astPath: [...(after?.astPath ?? []), Number.MAX_SAFE_INTEGER],
      text: '',
      displayText: '',
      checked: false,
      dueDate: null,
      updatedAt: Date.now(),
    }
    this.entries.set(row.key, { at: null, created: true, row, saved: row, after })
    this.emit()
    return row
  }

  /** Remember the text of an open editor. Notifies nobody and writes nothing. */
  draft(task: Task, text: string): void {
    this.entry(task).draft = text
  }

  /** Forget the open editor's text without saving it. */
  discardDraft(task: Task): void {
    const entry = this.entries.get(task.key)
    if (entry) entry.draft = undefined
  }

  /**
   * End an edit: save the draft when it changed the text, or remove the task
   * when it (or an untouched new task) is empty. Returns the task as it now
   * stands, or null when it was removed.
   */
  commitDraft(task: Task): Task | null {
    const entry = this.entries.get(task.key)
    const draft = entry?.draft
    if (entry) entry.draft = undefined
    if (entry?.gone) return null
    const text = (draft ?? entry?.row.text ?? task.text).trim()
    const untouchedNew = draft === undefined && entry?.created && entry.at === null && text === ''
    if ((draft !== undefined && text === '') || untouchedNew) {
      this.update(task, { removed: true })
      return null
    }
    if (draft !== undefined && text !== this.current(task).text.trim()) this.update(task, { text })
    return this.current(task)
  }

  /** Change what a task should be, and schedule its note. A draft still open on it is saved first. */
  update(task: Task, patch: TaskPatch): void {
    const entry = this.entry(task)
    if (patch.removed) entry.draft = undefined
    else if (entry.draft !== undefined && this.commitDraft(task) === null) return
    if (entry.gone) return
    entry.row = patched(entry.row, patch)
    if (patch.removed) entry.gone = 'removed'
    else if (patch.bullet) entry.gone = 'bullet'
    if (entry.gone) entry.recent = false
    this.start(task.notePath)
    this.emit()
  }

  private entry(task: Task): Entry {
    let entry = this.entries.get(task.key)
    if (!entry) {
      entry = {
        at: { path: task.astPath, text: task.text },
        created: false,
        row: task,
        saved: task,
      }
      this.entries.set(task.key, entry)
    }
    return entry
  }

  private note(path: string): Note {
    let note = this.notes.get(path)
    if (!note) {
      note = { running: null, failed: false }
      this.notes.set(path, note)
    }
    return note
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** Nothing pending and nothing to remember: the index alone describes the task. */
  private done(entry: Entry): boolean {
    return (
      entry.row === entry.saved &&
      entry.draft === undefined &&
      !(entry.recent && entry.row.checked) &&
      (!entry.created || entry.gone !== undefined)
    )
  }

  /** Index rows, with tasks the store knows given back the key the UI knows them by. */
  private rekey(indexed: readonly Task[]): Task[] {
    return indexed.map((task) => {
      for (const [key, entry] of this.entries) {
        if (
          key !== task.key &&
          entry.at &&
          entry.at.text === task.text &&
          samePath(entry.at.path, task.astPath) &&
          entry.row.notePath === task.notePath
        ) {
          return { ...task, key }
        }
      }
      return task
    })
  }

  /** Run the note's write loop unless it is already running or waiting for a retry. */
  private start(path: string): void {
    const note = this.note(path)
    if (note.running || note.failed) return
    note.running = this.drain(path, note).finally(() => {
      note.running = null
      if (!note.failed && this.pending(path).length > 0) this.start(path)
    })
  }

  private pending(path: string): [string, Entry][] {
    return [...this.entries].filter(
      ([, entry]) =>
        entry.row.notePath === path && entry.row !== entry.saved && entry.error === undefined,
    )
  }

  /** Make the file match every pending task of the note, one read-edit-write round per batch. */
  private async drain(path: string, note: Note): Promise<void> {
    let retries = 0
    while (!note.failed) {
      const batch = this.pending(path)
      if (batch.length === 0) return
      const rows = new Map(batch.map(([key, entry]) => [key, entry.row]))
      // A new task without text has nothing to write; removing it needs no read either.
      const work = batch.filter(
        ([, entry]) => entry.at !== null || (!entry.gone && entry.row.text.trim() !== ''),
      )
      let locations = new Map(
        [...this.entries].flatMap(([key, entry]) =>
          entry.at && entry.row.notePath === path ? [[key, entry.at] as const] : [],
        ),
      )
      let firstError: unknown
      try {
        if (work.length > 0) {
          const disk = await this.io.read(path)
          let source = disk ?? ''
          let tasks = projectTaskDocument(parseMarkdownAst(splitFrontmatter(source).body), true)
          for (const [key, entry] of work) {
            try {
              const applied = this.apply(locations, source, tasks, key, entry)
              source = applied.source
              tasks = applied.tasks
              locations = applied.locations
            } catch (error) {
              entry.error = error
              firstError ??= error
            }
          }
          if (source !== (disk ?? '')) await this.io.write(path, disk, source)
        }
      } catch (error) {
        if (isAppError(error) && error.kind === 'io' && retries < 2) {
          retries++
          await delay(retries === 1 ? 200 : 800)
          continue
        }
        note.failed = true
        this.io.failure(path, error, () => {
          note.failed = false
          this.start(path)
        })
        this.emit()
        return
      }
      for (const [key, entry] of this.entries) {
        if (entry.row.notePath !== path) continue
        entry.at = locations.get(key) ?? (entry.gone ? null : entry.at)
        if (rows.get(key) === entry.row && entry.error === undefined) entry.saved = entry.row
        if (this.done(entry)) this.entries.delete(key)
      }
      retries = 0
      if (firstError !== undefined) {
        this.io.failure(path, firstError, () => {
          for (const [, entry] of this.entries)
            if (entry.row.notePath === path) entry.error = undefined
          this.start(path)
        })
      } else {
        this.io.saved(path)
      }
      this.emit()
    }
  }

  /** Make one task in `source` match its row. Returns the new source, its tasks, and every task's new location. */
  private apply(
    locations: ReadonlyMap<string, Location>,
    source: string,
    tasks: readonly ParsedTask[],
    key: string,
    { row, gone, after }: Entry,
  ): { source: string; tasks: ParsedTask[]; locations: Map<string, Location> } {
    const location = locations.get(key)
    const found = location && find(tasks, location)
    if (location && !found && gone !== 'removed') {
      throw new Error('This task changed elsewhere. Your text is kept.')
    }
    let result: ReturnType<typeof editTaskDocument>
    if (found) {
      result = editTaskDocument(
        source,
        gone === 'removed'
          ? { at: found.astPath, remove: true }
          : {
              at: found.astPath,
              text: row.text,
              checked: row.checked,
              toBullet: gone === 'bullet',
            },
      )
    } else if (location || gone === 'removed') {
      return { source, tasks: [...tasks], locations: new Map(locations) }
    } else {
      const anchorLocation =
        after && (locations.get(after.key) ?? { path: after.astPath, text: after.text })
      const anchor = anchorLocation && find(tasks, anchorLocation)
      result = editTaskDocument(source, {
        after: anchor?.astPath ?? null,
        create: { text: row.text, checked: row.checked, bullet: gone === 'bullet' },
      })
    }
    const next = new Map<string, Location>()
    for (const [id, previous] of locations) {
      const moved = result.paths.get(encodeTaskPath(previous.path))
      if (moved) next.set(id, { path: moved, text: previous.text })
    }
    const landed = found ? result.paths.get(encodeTaskPath(found.astPath)) : result.createdPath
    if (landed && !gone) next.set(key, { path: landed, text: row.text })
    else next.delete(key)
    return { source: result.source, tasks: result.tasks, locations: next }
  }
}
