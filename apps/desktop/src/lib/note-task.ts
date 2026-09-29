import { openSession } from '@/editor/open-documents.ts'
import {
  editTaskDocument,
  hashContent,
  isAppError,
  readNote,
  writeNote,
  type TaskAddress,
  type TaskEdit,
} from '@reflect/core'

export interface TaskMutationReceipt {
  generation: number
  notePath: string
  beforeRevision: string
  revision: string
  source: string
  paths: ReadonlyMap<string, readonly number[]>
  tasks: ReturnType<typeof editTaskDocument>['tasks']
}
const listeners = new Set<(receipt: TaskMutationReceipt) => void>()
const queues = new Map<string, Promise<void>>()

/** Subscribe to completed task writes before their index echo arrives. */
export function onTaskMutation(listener: (receipt: TaskMutationReceipt) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Apply one atomic batch per note; successful notes survive a later note's failure. */
export async function mutateTasks(
  edits: readonly { task: TaskAddress; edit: Omit<TaskEdit, 'astPath'> }[],
  generation: number,
): Promise<void> {
  const notes = new Map<string, (typeof edits)[number][]>()
  for (const edit of edits) {
    const batch = notes.get(edit.task.notePath) ?? []
    batch.push(edit)
    notes.set(edit.task.notePath, batch)
  }
  for (const [path, batch] of notes) await mutateNote(path, batch, generation)
}

// FIXME: `mutateNote` this function is too complex. try to split it into smaller functions to improve readability and maintainability. Also, consider adding more comments to explain the logic and flow of the function.
async function mutateNote(
  path: string,
  edits: readonly { task: TaskAddress; edit: Omit<TaskEdit, 'astPath'> }[],
  generation: number,
  append = false,
): Promise<TaskAddress | undefined> {
  const key = `${generation}:${path}`
  const previous = queues.get(key) ?? Promise.resolve()
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const session = openSession(path)
      let missing = false
      let source: string
      const sessionSource = session?.liveContent()
      if (session) {
        const live = session.liveContent()
        if (live === null) throw new Error('The note is still loading. Try again shortly.')
        const disk = await readNote(path, generation)
        source = session.isDirty() ? live : disk
      } else {
        try {
          source = await readNote(path, generation)
        } catch (cause) {
          if (!append || !(isAppError(cause) && cause.kind === 'notFound')) throw cause
          source = ''
          missing = true
        }
      }
      const beforeRevision = await hashContent(source)
      if (edits.some(({ task }) => task.revision !== beforeRevision)) {
        throw new Error('This note changed. Your draft is kept; refresh before applying it again.')
      }
      const result = editTaskDocument(
        source,
        edits.map(({ task, edit }) => ({ ...edit, astPath: task.astPath })),
        append,
      )
      if (result.source !== source) {
        if (session) {
          const applied = await session.commitSourceEdit((current) => {
            if (openSession(path) !== session || current !== sessionSource)
              throw new Error('This note changed while saving. Your draft is kept.')
            return result.source
          })
          if (!applied) throw new Error('Resolve the note conflict before editing its tasks.')
          source = await readNote(path, generation)
        } else {
          await writeNote(path, result.source, generation, missing ? null : source)
          source = result.source
        }
      }
      const revision = await hashContent(source)
      const exact = source === result.source
      const actual = exact ? result : editTaskDocument(source, [])
      const receipt: TaskMutationReceipt = {
        generation,
        notePath: path,
        beforeRevision,
        revision,
        source,
        tasks: actual.tasks,
        paths: exact ? result.paths : new Map(),
      }
      for (const listener of listeners) listener(receipt)
      if (result.createdPath && exact)
        return { notePath: path, revision, astPath: result.createdPath }
      return
    })
  const settled = operation.then(
    () => {},
    () => {},
  )
  queues.set(key, settled)
  try {
    return await operation
  } finally {
    if (queues.get(key) === settled) queues.delete(key)
  }
}

// FIXME: operations like `mutateTasks`, are frontend(js)-backend(rust) communication, right? for these operations, we should use `react-query` to manage them. Use the react-query native and recommended way to manage these operations. Read docs. Do not create your own utils. This review comments is for the whole pull request. please review all changes in this pull request and make sure to use react-query for all frontend-backend communication
export function toggleTask(
  task: TaskAddress & { checked: boolean },
  generation: number,
): Promise<void> {
  return mutateTasks([{ task, edit: { checked: !task.checked } }], generation)
}
export function editTask(task: TaskAddress, content: string, generation: number): Promise<void> {
  return mutateTasks([{ task, edit: { firstParagraphMarkdown: content } }], generation)
}
export function deleteTask(task: TaskAddress, generation: number): Promise<void> {
  return mutateTasks([{ task, edit: { remove: true } }], generation)
}
export function convertTaskToBullet(task: TaskAddress, generation: number): Promise<void> {
  return mutateTasks([{ task, edit: { toBullet: true } }], generation)
}
export async function insertTask(notePath: string, generation: number): Promise<TaskAddress> {
  const created = await mutateNote(notePath, [], generation, true)
  if (!created)
    throw new Error('The note saved, but the new task could not be located. Refresh the task list.')
  return created
}
export async function continueTaskInContext(
  task: TaskAddress,
  content: string | null,
  generation: number,
): Promise<TaskAddress> {
  const created = await mutateNote(
    task.notePath,
    [
      {
        task,
        edit: {
          insertAfter: true,
          ...(content === ''
            ? { remove: true }
            : content !== null
              ? { firstParagraphMarkdown: content }
              : {}),
        },
      },
    ],
    generation,
  )
  if (!created)
    throw new Error('The note saved, but the new task could not be located. Refresh the task list.')
  return created
}
