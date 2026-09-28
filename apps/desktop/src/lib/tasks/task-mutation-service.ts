import {
  hashContent,
  isAppError,
  mapTaskOffsets,
  planTaskMutations,
  projectTaskSnapshots,
  readNote,
  ReflectError,
  writeNote,
  type TaskMutation,
  type TaskMutationPlan,
  type TaskRowSnapshot,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents.ts'

interface SourceEntry {
  source: string
  pins: number
}

/** Shared revisions are bounded; an active draft pins the source it can merge against. */
const sources = new Map<string, SourceEntry>()
const chains = new Map<string, Promise<void>>()
const MAX_SOURCES = 64
const MAX_SOURCE_UNITS = 16 * 1024 * 1024

function sourceKey(generation: number, path: string, revision: string): string {
  return `${generation}\0${path}\0${revision}`
}

export function rememberTaskSource(
  generation: number,
  path: string,
  revision: string,
  source: string,
): void {
  const key = sourceKey(generation, path, revision)
  const previous = sources.get(key)
  sources.delete(key)
  sources.set(key, previous ?? { source, pins: 0 })
  let units = [...sources.values()].reduce((total, entry) => total + entry.source.length, 0)
  for (const [candidate, entry] of sources) {
    if (sources.size <= MAX_SOURCES && units <= MAX_SOURCE_UNITS) break
    if (entry.pins > 0) continue
    sources.delete(candidate)
    units -= entry.source.length
  }
}

export async function pinTaskDraft(base: TaskRowSnapshot, generation: number): Promise<() => void> {
  const key = sourceKey(generation, base.anchor.notePath, base.anchor.revision)
  if (!sources.has(key)) {
    const owner = openSession(base.anchor.notePath)
    if (owner && owner.generation() !== generation)
      throw new ReflectError('io', 'The graph changed.')
    let source = owner?.liveContent()
    let revision = source == null ? undefined : await hashContent(source)
    // An indexed row can still name the disk revision while its open note has
    // unsaved input. Retain that exact base rather than rejecting the draft.
    if (source == null || revision !== base.anchor.revision) {
      source = await readNote(base.anchor.notePath)
      revision = await hashContent(source)
    }
    if (revision !== base.anchor.revision)
      throw new ReflectError('revisionConflict', 'Refresh this task before editing.')
    rememberTaskSource(generation, base.anchor.notePath, revision, source)
  }
  const entry = sources.get(key)
  if (!entry)
    throw new ReflectError(
      'revisionConflict',
      'This note is too large to retain an editing snapshot.',
    )
  entry.pins++
  let released = false
  return () => {
    if (!released) entry.pins--
    released = true
  }
}

export interface TaskMutationReceipt {
  operationId: string
  notePath: string
  beforeRevision: string
  persistedRevision: string
  bufferRevision: string
  persistedSource: string
  bufferSource: string
  tasks: readonly TaskRowSnapshot[]
  bufferTasks: readonly TaskRowSnapshot[]
  relocations: ReadonlyMap<number, TaskRowSnapshot | null>
  created: readonly TaskRowSnapshot[]
  status: 'persisted' | 'superseded'
}

function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const settled = result.then(
    () => {},
    () => {},
  )
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return result
}

/** One atomic source write per note. Cross-note callers receive separate results. */
export function mutateNoteTasks(
  notePath: string,
  generation: number,
  operations: readonly TaskMutation[],
  append = false,
): Promise<TaskMutationReceipt> {
  if (operations.some((operation) => operation.base.anchor.notePath !== notePath)) {
    return Promise.reject(new ReflectError('revisionConflict', 'Task belongs to another note.'))
  }
  const operationId = crypto.randomUUID()
  return serial(`${generation}\0${notePath}`, async () => {
    for (let attempt = 0; ; attempt++) {
      let expected: string | null
      try {
        expected = await readNote(notePath)
      } catch (cause) {
        if (!isAppError(cause) || cause.kind !== 'notFound' || !append) throw cause
        expected = null
      }
      const diskSource = expected ?? ''
      const diskRevision = await hashContent(diskSource)
      rememberTaskSource(generation, notePath, diskRevision, diskSource)
      const owner = openSession(notePath)
      let beforeSource = diskSource
      let plan: TaskMutationPlan | undefined
      const transform = async (source: string): Promise<string> => {
        const revision = await hashContent(source)
        rememberTaskSource(generation, notePath, revision, source)
        beforeSource = source
        plan = planTaskMutations(
          source,
          revision,
          operations,
          (revision) => sources.get(sourceKey(generation, notePath, revision))?.source,
          append,
        )
        return plan.source
      }
      let persistedSource: string
      let bufferSource: string
      try {
        if (owner) {
          if (owner.generation() !== generation || owner.path !== notePath)
            throw new ReflectError('io', 'The note or graph changed.')
          const receipt = await owner.commitSourceMutation(transform, generation)
          if (!receipt)
            throw new ReflectError(
              'revisionConflict',
              'This note cannot be changed until its current conflict is resolved.',
            )
          persistedSource = receipt.persistedSource
          bufferSource = receipt.bufferSource
        } else {
          persistedSource = await transform(diskSource)
          await writeNote(notePath, persistedSource, generation, expected)
          bufferSource = persistedSource
        }
      } catch (cause) {
        // Open sessions own recovery and protect their later input. Never bypass
        // a parked session conflict by falling back to a disk write.
        if (!owner && attempt < 2 && isAppError(cause) && cause.kind === 'revisionConflict')
          continue
        throw cause
      }
      if (!plan) throw new Error('Task mutation did not produce a source plan')
      const appliedPlan = plan
      const [beforeRevision, persistedRevision, bufferRevision] = await Promise.all([
        hashContent(beforeSource),
        hashContent(persistedSource),
        hashContent(bufferSource),
      ])
      rememberTaskSource(generation, notePath, beforeRevision, beforeSource)
      rememberTaskSource(generation, notePath, persistedRevision, persistedSource)
      rememberTaskSource(generation, notePath, bufferRevision, bufferSource)
      const tasks = projectTaskSnapshots(notePath, persistedSource, persistedRevision)
      const bufferTasks =
        bufferSource === persistedSource
          ? tasks
          : projectTaskSnapshots(notePath, bufferSource, bufferRevision)
      const relocations = new Map<number, TaskRowSnapshot | null>()
      const known = new Set<TaskRowSnapshot>()
      const byOffset = new Map(tasks.map((task) => [task.anchor.markerOffset, task]))
      const offsets = mapTaskOffsets(
        appliedPlan.before.map((task) => task.marker.from),
        appliedPlan.edits,
      )
      // Exact patches prove identity. If editor normalization or later input
      // changed the candidate, return snapshots without claiming a false map.
      if (appliedPlan.source === persistedSource) {
        for (const previous of appliedPlan.before) {
          const row = appliedPlan.removed.has(previous.marker.from)
            ? null
            : (byOffset.get(offsets.get(previous.marker.from)!) ?? null)
          relocations.set(previous.marker.from, row)
          if (row) known.add(row)
        }
      }
      const created =
        appliedPlan.source === persistedSource ? tasks.filter((task) => !known.has(task)) : []
      return {
        operationId,
        notePath,
        beforeRevision,
        persistedRevision,
        bufferRevision,
        persistedSource,
        bufferSource,
        tasks,
        bufferTasks,
        relocations,
        created,
        status: appliedPlan.source === persistedSource ? 'persisted' : 'superseded',
      }
    }
  })
}

export async function mutateTaskBatch(
  generation: number,
  operations: readonly TaskMutation[],
): Promise<PromiseSettledResult<TaskMutationReceipt>[]> {
  const groups = new Map<string, TaskMutation[]>()
  for (const operation of operations) {
    const path = operation.base.anchor.notePath
    const group = groups.get(path) ?? []
    group.push(operation)
    groups.set(path, group)
  }
  return await Promise.allSettled(
    [...groups].map(([path, group]) => mutateNoteTasks(path, generation, group)),
  )
}
