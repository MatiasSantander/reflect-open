import { parseMarkdownAst } from '@meowdown/markdown'
import { isAppError } from '../errors.ts'
import { clearTaskDueDate, setTaskDueDate } from '../markdown/edit.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import type { ParsedTask } from '../markdown/model.ts'
import { inlineMarkdownToDisplayText } from '../markdown/plain-text.ts'
import { taskDueDate } from '../markdown/task-due-date.ts'
import { editTaskDocument, type NewTask } from '../markdown/task-mutation.ts'
import { encodeTaskPath } from '../markdown/task-path.ts'
import { projectTaskDocument } from '../markdown/task-projection.ts'

/** A task as the Tasks surfaces show it. Index rows and tasks created locally share this shape. */
export interface Task {
  /** Stable identity: `notePath#astPath` for an indexed task, a random id for one created here. */
  key: string
  notePath: string
  /** Where the task sits in its note's AST. Absent until a task created here is written. */
  astPath?: readonly number[] | undefined
  /** List position for a new task placed after another, until it has an `astPath`. */
  sortPath?: readonly number[] | undefined
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
  /** A note's pending changes could not be saved; `retry` resumes them. */
  failure: (path: string, error: unknown, retry: () => void) => void
  /** A note's pending changes are all on disk. */
  saved: (path: string) => void
}

/** The note a new task goes into, with the metadata its row shows before the index has it. */
export type TaskTarget = Pick<
  Task,
  'notePath' | 'noteTitle' | 'dailyDate' | 'isPinned' | 'pinnedOrder'
> & { breadcrumbs?: readonly string[] | undefined }

/** A task whose desired state differs from the index. */
interface Local {
  /** The index row the change started from; null for a task created here. */
  base: Task | null
  /** The task as it should be. */
  row: Task
  /** Set when the task should leave the note as a checkbox. */
  gone?: 'removed' | 'bullet' | undefined
}

interface Note {
  local: Map<string, Local>
  /** Keys whose desired state the file does not have yet. */
  dirty: Set<string>
  /** Keys the running write is applying. */
  writing: Set<string>
  /** Text typed into an open editor, by key, until the edit ends. */
  drafts: Map<string, string>
  /** For a task created here: the task it is inserted after. */
  anchors: Map<string, Task>
  /** Where each task created here now lives in the note. */
  addresses: Map<string, readonly number[]>
  running: Promise<void> | null
  /** True after a failed write, until the host retries. */
  failed: boolean
}

/** The key of an indexed task. */
export function indexedTaskKey(notePath: string, astPath: readonly number[]): string {
  return `${notePath}#${encodeTaskPath(astPath)}`
}

function samePath(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return left !== undefined && encodeTaskPath(left) === encodeTaskPath(right)
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Every task change made outside a note's own editor goes through here: the
 * Tasks view, the mobile sheet, and backlink checkboxes. One instance serves
 * one graph.
 *
 * The index is the read model. The store only remembers what the index does
 * not know yet: for each note, the tasks whose desired state differs from the
 * index (`local`), and which of them the file does not have yet (`dirty`).
 * `list` overlays `local` on the index rows; `update` changes a task's desired
 * state and schedules its note; the note's write loop then reads the file,
 * makes every dirty task look like its desired state, writes once, and forgets
 * the local rows the write covered. `io.write` resolves only after the index
 * and the task queries reflect the write, so nothing is forgotten early.
 *
 * A task created here has a random key and no address until written. Typing
 * goes to `draft`, which stores text without notifying anyone; `commitDraft`
 * turns it into an update when the edit ends, and `update` folds a pending
 * draft in first, so a checkbox click during an edit acts on the typed text.
 * An emptied task, or an abandoned empty new task, is removed; an empty new
 * task is never written.
 *
 * Tasks completed through `complete` stay listed, struck, until `archive`
 * (V1's middle state). A task the index shows open again was reopened at its
 * source and drops out of that set.
 */
export class TaskStore {
  private readonly notes = new Map<string, Note>()
  private readonly recent = new Map<string, Task>()
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

  /** Resolve once every running write loop has drained or failed. */
  readonly flush = async (): Promise<void> => {
    await Promise.all(
      [...this.notes.values()].flatMap((note) => (note.running ? [note.running] : [])),
    )
  }

  /**
   * The tasks to show: the open index rows, this session's completed tasks
   * (struck, until archived), the completed history when `completed` is given,
   * all with local changes applied.
   */
  list(open: readonly Task[], completed?: readonly Task[]): Task[] {
    const rows = new Map<string, Task>()
    for (const task of this.rekey(open)) rows.set(task.key, task)
    for (const task of this.rekey(completed ?? [])) rows.set(task.key, task)
    for (const [key, task] of this.recent) if (!rows.has(key)) rows.set(key, task)
    for (const note of this.notes.values()) {
      for (const [key, local] of note.local) {
        if (local.gone) rows.delete(key)
        else if (rows.has(key) || local.base === null) rows.set(key, local.row)
      }
    }
    return [...rows.values()].filter(
      (task) => !task.checked || completed !== undefined || this.recent.has(task.key),
    )
  }

  /** Complete a task from the list. It stays listed, struck, until `archive`. */
  complete(task: Task): void {
    this.update(task, { checked: true })
    const row = this.current(task)
    if (row.checked) this.recent.set(task.key, row)
  }

  /** Whether a task was completed in this session and not archived yet. */
  isRecent(task: Task): boolean {
    return this.recent.has(task.key)
  }

  /** Stop listing this session's completed tasks. They stay `[x]` on disk. */
  archive(): void {
    this.recent.clear()
    this.emit()
  }

  /** The task as it should be now, including changes not written yet. */
  current(task: Task): Task {
    return this.notes.get(task.notePath)?.local.get(task.key)?.row ?? task
  }

  /**
   * Create an empty task and return it. With `after`, the task is inserted
   * right below that task and sorted there. Nothing is written until it has text.
   */
  create(target: TaskTarget, after?: Task): Task {
    const note = this.note(target.notePath)
    const row: Task = {
      ...target,
      breadcrumbs: target.breadcrumbs ?? [],
      key: crypto.randomUUID(),
      text: '',
      displayText: '',
      checked: false,
      dueDate: null,
      updatedAt: Date.now(),
    }
    if (after) {
      note.anchors.set(row.key, after)
      const path = after.sortPath ?? after.astPath
      if (path?.length) row.sortPath = [...path, Number.MAX_SAFE_INTEGER]
    }
    note.local.set(row.key, { base: null, row })
    this.emit()
    return row
  }

  /** Remember the text of an open editor. Notifies nobody and writes nothing. */
  draft(task: Task, text: string): void {
    this.note(task.notePath).drafts.set(task.key, text)
  }

  /** Forget the open editor's text without saving it. */
  discardDraft(task: Task): void {
    this.note(task.notePath).drafts.delete(task.key)
  }

  /**
   * End an edit: save the draft when it changed the text, or remove the task
   * when it (or an untouched new task) is empty. Returns the task as it now
   * stands, or null when it was removed.
   */
  commitDraft(task: Task): Task | null {
    const note = this.note(task.notePath)
    const draft = note.drafts.get(task.key)
    note.drafts.delete(task.key)
    const local = note.local.get(task.key)
    if (local?.gone) return null
    const text = (draft ?? local?.row.text ?? task.text).trim()
    const untouchedNew = draft === undefined && local?.base === null && text === ''
    if ((draft !== undefined && text === '') || untouchedNew) {
      this.update(task, { removed: true })
      return null
    }
    if (draft !== undefined && text !== this.current(task).text.trim()) this.update(task, { text })
    return this.current(task)
  }

  /** Change what a task should be, and schedule its note. A draft still open on it is saved first. */
  update(task: Task, patch: TaskPatch): void {
    const note = this.note(task.notePath)
    if (patch.removed) note.drafts.delete(task.key)
    else if (note.drafts.has(task.key) && this.commitDraft(task) === null) return
    const local = note.local.get(task.key)
    if (local?.gone) return
    const row = patched(local?.row ?? task, patch)
    const gone = patch.removed ? 'removed' : patch.bullet ? 'bullet' : undefined
    const unwritten =
      local?.base === null &&
      !note.dirty.has(task.key) &&
      !note.writing.has(task.key) &&
      !note.addresses.has(task.key)
    if (gone && unwritten) {
      note.local.delete(task.key)
      note.anchors.delete(task.key)
      this.recent.delete(task.key)
      this.emit()
      return
    }
    note.local.set(task.key, { base: local ? local.base : task, row, gone })
    if (gone || patch.checked === false) this.recent.delete(task.key)
    else if (this.recent.has(task.key)) this.recent.set(task.key, row)
    if (gone || row.text.trim() !== '') {
      note.dirty.add(task.key)
      this.start(task.notePath, note)
    }
    this.emit()
  }

  private note(path: string): Note {
    let note = this.notes.get(path)
    if (!note) {
      note = {
        local: new Map(),
        dirty: new Set(),
        writing: new Set(),
        drafts: new Map(),
        anchors: new Map(),
        addresses: new Map(),
        running: null,
        failed: false,
      }
      this.notes.set(path, note)
    }
    return note
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** Index rows, with tasks created here given back the key the UI knows them by. */
  private rekey(indexed: readonly Task[]): Task[] {
    return indexed.map((task) => {
      const note = this.notes.get(task.notePath)
      if (!note) return task
      for (const [key, astPath] of note.addresses) {
        if (samePath(task.astPath, astPath)) return { ...task, key }
      }
      return task
    })
  }

  /** Run the note's write loop unless it is already running or waiting for a retry. */
  private start(path: string, note: Note): void {
    if (note.running || note.failed) return
    note.running = this.drain(path, note).finally(() => {
      note.running = null
      if (note.dirty.size > 0 && !note.failed) this.start(path, note)
    })
  }

  /** Make the file match every dirty task, in one read-edit-write round per batch. */
  private async drain(path: string, note: Note): Promise<void> {
    let retries = 0
    while (note.dirty.size > 0 && !note.failed) {
      const keys = [...note.dirty]
      note.dirty.clear()
      note.writing = new Set(keys)
      try {
        const disk = await this.io.read(path)
        let source = disk ?? ''
        let tasks = projectTaskDocument(parseMarkdownAst(splitFrontmatter(source).body), true)
        let addresses = new Map(note.addresses)
        for (const key of keys) {
          const local = note.local.get(key)
          if (!local) continue
          const applied = this.apply(addresses, source, tasks, key, local, note.anchors.get(key))
          source = applied.source
          tasks = applied.tasks
          addresses = applied.addresses
        }
        if (source !== (disk ?? '')) await this.io.write(path, disk, source)
        note.addresses = addresses
        for (const key of keys) {
          if (note.dirty.has(key)) continue
          // A task created here keeps its address so index rows map back to its key.
          if (note.local.get(key)?.base !== null) note.addresses.delete(key)
          note.local.delete(key)
          note.anchors.delete(key)
        }
        note.writing.clear()
        retries = 0
        this.io.saved(path)
        this.emit()
      } catch (error) {
        note.writing.clear()
        for (const key of keys) note.dirty.add(key)
        if (isAppError(error) && error.kind === 'io' && retries < 2) {
          retries++
          await delay(retries === 1 ? 200 : 800)
          continue
        }
        note.failed = true
        this.io.failure(path, error, () => {
          note.failed = false
          this.start(path, note)
        })
        this.emit()
      }
    }
  }

  /**
   * Find a task among `tasks`. A task with a recorded address is there. Any
   * other task must still carry the text the caller saw at its path;
   * otherwise its text must be unique in the note. Undefined when the task
   * does not exist yet.
   */
  private locate(
    addresses: ReadonlyMap<string, readonly number[]>,
    tasks: readonly ParsedTask[],
    key: string,
    base: Task | null,
  ): ParsedTask | undefined {
    const recorded = addresses.get(key)
    const path = recorded ?? base?.astPath
    if (!path) return undefined
    const atPath = tasks.find((task) => samePath(path, task.astPath))
    if (atPath && (recorded || atPath.text === base?.text)) return atPath
    const byText = base ? tasks.filter((task) => task.text === base.text) : []
    if (byText.length === 1) return byText[0]
    throw new Error('This task changed elsewhere. Your text is kept.')
  }

  /**
   * Make one task in `source` match its desired state. Returns the new source,
   * its tasks, and where every task with a local row now lives.
   */
  private apply(
    addresses: ReadonlyMap<string, readonly number[]>,
    source: string,
    tasks: readonly ParsedTask[],
    key: string,
    { base, row, gone }: Local,
    anchor: Task | undefined,
  ): { source: string; tasks: ParsedTask[]; addresses: Map<string, readonly number[]> } {
    const found = this.locate(addresses, tasks, key, base)
    let result: ReturnType<typeof editTaskDocument>
    if (found) {
      result = editTaskDocument(source, {
        astPath: found.astPath,
        ...(gone === 'removed'
          ? { remove: true }
          : { text: row.text, checked: row.checked, toBullet: gone === 'bullet' }),
      })
    } else if (gone === 'removed') {
      return { source, tasks: [...tasks], addresses: new Map(addresses) }
    } else {
      const created: NewTask = { text: row.text, checked: row.checked, bullet: gone === 'bullet' }
      const anchorTask = anchor && this.locate(addresses, tasks, anchor.key, anchor)
      if (anchor && !anchorTask) {
        throw new Error('The task insertion position changed. Your text is kept.')
      }
      result = anchorTask
        ? editTaskDocument(source, { astPath: anchorTask.astPath, insertAfter: created })
        : editTaskDocument(source, null, created)
    }
    const next = new Map<string, readonly number[]>()
    for (const [id, astPath] of addresses) {
      const moved = result.paths.get(encodeTaskPath(astPath))
      if (moved) next.set(id, moved)
    }
    const landed = found ? result.paths.get(encodeTaskPath(found.astPath)) : result.createdPath
    if (landed && !gone) next.set(key, landed)
    return { source: result.source, tasks: result.allTasks, addresses: next }
  }
}
