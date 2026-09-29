import { parseMarkdownAst } from '@meowdown/markdown'
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
  /**
   * Identity: `notePath#astPath` for an indexed task, a random id for one
   * created here until the index lists it.
   */
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
  /** Some of a note's changes could not be saved; `retry` tries them again. */
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
  saved: Task
  /** The task should leave the note as a checkbox. */
  gone?: 'removed' | 'bullet' | undefined
  /** For a task created here: the task it is inserted after, at its last known location. */
  after?: Task | undefined
  /** Text typed into an open editor, until the edit ends. */
  draft?: string | undefined
  /** Completed here; stays listed, struck, until archived. */
  recent?: boolean | undefined
  /** The last write could not take this change; cleared by a retry or a further change. */
  error?: unknown
}

interface Note {
  running: Promise<void> | null
  /** The source last read or written, to tell an outside change from our own. */
  source?: string | null | undefined
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

/**
 * The task at `location`. Its path counts only while the note has not changed
 * since the store last saw it; otherwise, or when the path no longer holds
 * that text, the task must be the only one with its text.
 */
function find(
  tasks: readonly ParsedTask[],
  location: Location,
  trustPaths: boolean,
): ParsedTask | undefined {
  if (trustPaths) {
    const atPath = tasks.find((task) => samePath(task.astPath, location.path))
    if (atPath?.text === location.text) return atPath
  }
  const byText = tasks.filter((task) => task.text === location.text)
  return byText.length === 1 ? byText[0] : undefined
}

function conflict(): Error {
  return new Error('This task changed elsewhere. Your text is kept.')
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
 * reflect the write, so an entry is forgotten only once the index shows it.
 *
 * A task created here has a random key until the index lists it; the entry
 * maps the index row at its location back to that key while the entry lives.
 * Typing goes to `draft`, which stores text without notifying anyone;
 * `commitDraft` turns it into an update when the edit ends, and `update` folds
 * a pending draft in first, so a checkbox click during an edit acts on the
 * typed text. An emptied task, or an abandoned empty new task, is removed; an
 * empty new task is never written.
 *
 * Tasks completed through `setChecked` stay listed, struck, until `archive`
 * (V1's middle state). A change the note cannot take waits with its own
 * error, reported once per note, without blocking the note's other changes;
 * a retry or a further change tries it again.
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

  /** Save every open draft, then resolve once no write loop is running. */
  readonly flush = async (): Promise<void> => {
    for (const entry of this.entries.values()) {
      if (entry.draft !== undefined) this.commitDraft(entry.row)
    }
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
    // Index rows of tasks created here take the key the UI already holds.
    const claims = new Map<string, string>()
    for (const [key, entry] of this.entries) {
      if (entry.at && key !== indexedTaskKey(entry.row.notePath, entry.at.path)) {
        claims.set(`${indexedTaskKey(entry.row.notePath, entry.at.path)}\n${entry.at.text}`, key)
      }
    }
    const rows = new Map<string, Task>()
    for (const task of [...open, ...(completed ?? [])]) {
      const key = claims.get(`${task.key}\n${task.text}`) ?? task.key
      rows.set(key, key === task.key ? task : { ...task, key })
    }
    for (const [key, entry] of this.entries) {
      if (entry.gone) {
        rows.delete(key)
        continue
      }
      // Without an index row, a task created here shows itself until the index
      // lists it; a struck one shows itself until archived.
      const pending = entry.row !== entry.saved
      const own = entry.created && (entry.at === null || pending)
      const base = rows.get(key) ?? (own || entry.recent ? entry.row : undefined)
      if (!base) continue
      const { text, displayText, checked, dueDate } = entry.row
      rows.set(key, pending ? { ...base, text, displayText, checked, dueDate } : base)
    }
    return [...rows.values()].filter(
      (task) => !task.checked || completed !== undefined || this.entries.get(task.key)?.recent,
    )
  }

  /**
   * Check or uncheck tasks. A task completed here stays listed, struck, until
   * `archive`; tasks already in the wanted state are left alone.
   */
  setChecked(tasks: readonly Task[], checked: boolean): void {
    for (const task of tasks) {
      if (this.current(task).checked === checked) continue
      this.update(task, { checked })
      const entry = this.entries.get(task.key)
      if (checked && entry?.row.checked) entry.recent = true
    }
  }

  /** ⌘↵ on a selection: reopen every task when all are checked, else complete the open ones. */
  toggle(tasks: readonly Task[]): void {
    this.setChecked(tasks, !tasks.every((task) => this.current(task).checked))
  }

  remove(tasks: readonly Task[]): void {
    for (const task of tasks) this.update(task, { removed: true })
  }

  /** Set every task's due date to `isoDate`, or clear it when null. */
  schedule(tasks: readonly Task[], isoDate: string | null): void {
    for (const task of tasks) this.update(task, { dueDate: isoDate })
  }

  /** Drop every task's checkbox so the line stays in its note as a plain bullet. */
  convertToBullet(tasks: readonly Task[]): void {
    for (const task of tasks) this.update(task, { bullet: true })
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
    const untouchedNew = draft === undefined && entry?.at === null && text === ''
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
    entry.error = undefined
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
      note = { running: null }
      this.notes.set(path, note)
    }
    return note
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /**
   * Nothing pending and nothing to remember. A task created here keeps its
   * entry, and so its key, while it stays in the note as a checkbox.
   */
  private done(entry: Entry): boolean {
    return (
      entry.row === entry.saved &&
      entry.draft === undefined &&
      entry.error === undefined &&
      !(entry.recent && entry.row.checked) &&
      (!entry.created || entry.gone !== undefined)
    )
  }

  private pending(path: string): [string, Entry][] {
    return [...this.entries].filter(
      ([, entry]) =>
        entry.row.notePath === path && entry.row !== entry.saved && entry.error === undefined,
    )
  }

  /** Run the note's write loop unless it is already running. */
  private start(path: string): void {
    const note = this.note(path)
    if (note.running) return
    note.running = this.drain(path, note).finally(() => {
      note.running = null
      if (this.pending(path).length > 0) this.start(path)
    })
  }

  /** Make the file match every pending task of the note, one read-edit-write round per batch. */
  private async drain(path: string, note: Note): Promise<void> {
    for (;;) {
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
      let error: unknown
      if (work.length > 0) {
        const previous = new Map(locations)
        try {
          const disk = await this.io.read(path)
          const trustPaths = note.source === undefined || note.source === disk
          note.source = disk
          let source = disk ?? ''
          let tasks = projectTaskDocument(parseMarkdownAst(splitFrontmatter(source).body), true)
          for (const [key, entry] of work) {
            try {
              const applied = this.apply(locations, trustPaths, source, tasks, key, entry)
              source = applied.source
              tasks = applied.tasks
              locations = applied.locations
            } catch (failure) {
              entry.error = failure
              error ??= failure
            }
          }
          // The new locations show before the index refetch, so a written task is
          // never listed twice.
          this.relocate(path, locations)
          if (source !== (disk ?? '')) {
            await this.io.write(path, disk, source)
            note.source = source
          }
        } catch (failure) {
          this.relocate(path, previous)
          for (const [, entry] of work) entry.error = failure
          error = failure
        }
      }
      for (const [key, entry] of this.entries) {
        if (
          entry.row.notePath === path &&
          rows.get(key) === entry.row &&
          entry.error === undefined
        ) {
          entry.saved = entry.row
        }
      }
      this.settle(path)
      const stillFailing = [...this.entries.values()].some(
        (entry) => entry.row.notePath === path && entry.error !== undefined,
      )
      if (error !== undefined) {
        this.io.failure(path, error, () => {
          for (const entry of this.entries.values()) {
            if (entry.row.notePath === path) entry.error = undefined
          }
          this.start(path)
        })
      } else if (!stillFailing) {
        this.io.saved(path)
      }
      this.emit()
      if (error !== undefined) return
    }
  }

  /** Give every entry of the note its new location; tasks that left the note, or were never written, have none. */
  private relocate(path: string, locations: ReadonlyMap<string, Location>): void {
    for (const entry of this.entries.values()) {
      if (entry.row.notePath === path) entry.at = locations.get(entry.row.key) ?? null
    }
  }

  /**
   * After a write: tasks the index alone describes are forgotten, a task
   * created after a forgotten one remembers where that one was, and every
   * indexed task takes the key of its new location.
   */
  private settle(path: string): void {
    const own = [...this.entries].filter(([, entry]) => entry.row.notePath === path)
    for (const [key, entry] of own) {
      if (!this.done(entry)) continue
      this.entries.delete(key)
      for (const [, other] of own) {
        if (other.after?.key === key && entry.at) {
          other.after = { ...other.after, astPath: entry.at.path, text: entry.at.text }
        }
      }
    }
    const renamed = own.flatMap(([key, entry]) => {
      if (!this.entries.has(key) || entry.created || !entry.at) return []
      const next = indexedTaskKey(path, entry.at.path)
      return next === key ? [] : [[key, next, entry] as const]
    })
    for (const [key] of renamed) this.entries.delete(key)
    for (const [, next, entry] of renamed) {
      const unchanged = entry.row === entry.saved
      entry.row = { ...entry.row, key: next }
      entry.saved = unchanged ? entry.row : { ...entry.saved, key: next }
      this.entries.set(next, entry)
    }
  }

  /** Make one task in `source` match its row. Returns the new source, its tasks, and every task's new location. */
  private apply(
    locations: ReadonlyMap<string, Location>,
    trustPaths: boolean,
    source: string,
    tasks: readonly ParsedTask[],
    key: string,
    { at, row, gone, after }: Entry,
  ): { source: string; tasks: ParsedTask[]; locations: Map<string, Location> } {
    const location = locations.get(key)
    if (at !== null && !location) throw conflict()
    const found = location && find(tasks, location, trustPaths)
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
    } else if (location) {
      if (gone === 'removed') return { source, tasks: [...tasks], locations: new Map(locations) }
      throw conflict()
    } else {
      const anchorLocation =
        after && (locations.get(after.key) ?? { path: after.astPath, text: after.text })
      const anchor = anchorLocation && find(tasks, anchorLocation, trustPaths)
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
