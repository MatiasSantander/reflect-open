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

interface TaskChange {
  task: TaskAddress
  edit: Omit<TaskEdit, 'astPath'>
}

interface NoteSource {
  source: string
  missing: boolean
  session: ReturnType<typeof openSession>
  buffer: string | null | undefined
}

export interface CreatedTask extends TaskAddress {
  receipts: TaskMutationReceipt[]
}

/** Capture the live buffer before awaiting IO, so later input invalidates this snapshot. */
async function loadTaskSource(
  path: string,
  generation: number,
  append: boolean,
): Promise<NoteSource> {
  const session = openSession(path)
  const buffer = session?.liveContent()
  if (session && buffer == null) throw new Error('The note is still loading. Try again shortly.')
  try {
    const disk = await readNote(path, generation)
    return {
      source: session?.isDirty() && buffer != null ? buffer : disk,
      missing: false,
      session,
      buffer,
    }
  } catch (cause) {
    if (session || !append || !(isAppError(cause) && cause.kind === 'notFound')) throw cause
    return { source: '', missing: true, session, buffer }
  }
}

/** Save against the captured buffer/file and return the actual persisted source. */
async function saveTaskSource(
  path: string,
  generation: number,
  snapshot: NoteSource,
  next: string,
): Promise<string> {
  if (next === snapshot.source) return snapshot.source
  if (!snapshot.session) {
    await writeNote(path, next, generation, snapshot.missing ? null : snapshot.source)
    return next
  }
  const { session, buffer } = snapshot
  const applied = await session.commitSourceEdit((current) => {
    if (openSession(path) !== session || current !== buffer)
      throw new Error('This note changed while saving. Your draft is kept.')
    return next
  })
  if (!applied) throw new Error('Resolve the note conflict before editing its tasks.')
  return await readNote(path, generation)
}

async function mutateNote(
  path: string,
  edits: readonly TaskChange[],
  generation: number,
  append = false,
) {
  const snapshot = await loadTaskSource(path, generation, append)
  const beforeRevision = await hashContent(snapshot.source)
  if (edits.some(({ task }) => task.revision !== beforeRevision))
    throw new Error('This note changed. Your draft is kept; refresh before applying it again.')
  const result = editTaskDocument(
    snapshot.source,
    edits.map(({ task, edit }) => ({ ...edit, astPath: task.astPath })),
    append,
  )
  const source = await saveTaskSource(path, generation, snapshot, result.source)
  const revision = await hashContent(source)
  // A session can normalize the source; only exact output proves the address mapping.
  const exact = source === result.source
  const receipt: TaskMutationReceipt = {
    generation,
    notePath: path,
    beforeRevision,
    revision,
    source,
    tasks: exact ? result.tasks : editTaskDocument(source, []).tasks,
    paths: exact ? result.paths : new Map(),
  }
  return { receipt, createdPath: exact ? result.createdPath : undefined }
}

/** Apply one atomic batch per note; earlier saved notes survive a later failure. */
export async function mutateTasks(
  edits: readonly TaskChange[],
  generation: number,
): Promise<TaskMutationReceipt[]> {
  const notes = new Map<string, TaskChange[]>()
  for (const edit of edits) {
    const batch = notes.get(edit.task.notePath) ?? []
    batch.push(edit)
    notes.set(edit.task.notePath, batch)
  }
  const receipts: TaskMutationReceipt[] = []
  for (const [path, batch] of notes)
    receipts.push((await mutateNote(path, batch, generation)).receipt)
  return receipts
}

/** Set the opposite of the captured checked state. */
export function toggleTask(
  task: TaskAddress & { checked: boolean },
  generation: number,
): Promise<TaskMutationReceipt[]> {
  return mutateTasks([{ task, edit: { checked: !task.checked } }], generation)
}
/** Replace the first paragraph's Markdown. */
export function editTask(
  task: TaskAddress,
  content: string,
  generation: number,
): Promise<TaskMutationReceipt[]> {
  return mutateTasks([{ task, edit: { text: content } }], generation)
}
/** Remove the task and promote its details. */
export function deleteTask(task: TaskAddress, generation: number): Promise<TaskMutationReceipt[]> {
  return mutateTasks([{ task, edit: { remove: true } }], generation)
}
/** Convert the task into a plain bullet, preserving details. */
export function convertTaskToBullet(
  task: TaskAddress,
  generation: number,
): Promise<TaskMutationReceipt[]> {
  return mutateTasks([{ task, edit: { toBullet: true } }], generation)
}

function createdTask(result: Awaited<ReturnType<typeof mutateNote>>): CreatedTask {
  if (!result.createdPath)
    throw new Error('The note saved, but the new task could not be located. Refresh the task list.')
  const { notePath, revision } = result.receipt
  return { notePath, revision, astPath: result.createdPath, receipts: [result.receipt] }
}

/** Append an empty task to a note, creating the note if necessary. */
export async function insertTask(notePath: string, generation: number): Promise<CreatedTask> {
  return createdTask(await mutateNote(notePath, [], generation, true))
}
/** Commit the paragraph and add a sibling in the same write. */
export async function continueTaskInContext(
  task: TaskAddress,
  content: string | null,
  generation: number,
): Promise<CreatedTask> {
  return createdTask(
    await mutateNote(
      task.notePath,
      [
        {
          task,
          edit: {
            insertAfter: true,
            ...(content === '' ? { remove: true } : content !== null ? { text: content } : {}),
          },
        },
      ],
      generation,
    ),
  )
}
