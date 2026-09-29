import {
  createTaskController,
  readNote,
  writeNote,
  isAppError,
  ReflectError,
  type TaskCommand,
  type TaskAttempt,
} from '@reflect/core'
import { openSession, registerPendingWriter } from '@/editor/open-documents.ts'
import { toast } from '@/components/ui/toast.tsx'
import { readTaskJournal, writeTaskJournal } from './task-journal.ts'

const controllers = new Map<string, ReturnType<typeof createTaskController>>()
const retirements = new Map<string, () => Promise<void>>()

/** Release graph-scoped writers after edit finalizers have submitted their drafts. */
export async function retireTaskControllers(): Promise<void> {
  await Promise.all([...retirements.values()].map((retire) => retire()))
}

/** One task writer per graph lifetime, shared by every task surface. */
export function taskController(root: string, generation: number) {
  const key = JSON.stringify([root, generation])
  const existing = controllers.get(key)
  if (existing) return existing
  let active = true
  const assertActive = () => {
    if (!active) throw new Error('This graph session has closed.')
  }
  const failures = new Set<string>()
  const journals = new Map<string, Promise<void>>()
  function checkpoint(path: string, commands: readonly TaskCommand[], attempt: TaskAttempt | null) {
    const snapshot = structuredClone({ commands, attempt })
    const previous = journals.get(path) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await ready
        if (!active) return
        await writeTaskJournal(root, path, snapshot.commands, snapshot.attempt)
      })
    journals.set(path, next)
    return next
  }
  const controller = createTaskController({
    ready: () => ready,
    async read(path) {
      await ready
      assertActive()
      const session = openSession(path, generation)
      if (session) {
        const source = session.liveContent()
        if (source === null) throw new Error('This note is still loading.')
        return source
      }
      try {
        return await readNote(path, generation)
      } catch (error) {
        if (isAppError(error) && error.kind === 'notFound') return null
        throw error
      }
    },
    async write(path, before, source) {
      assertActive()
      const session = openSession(path, generation)
      if (session) {
        let savedSource = source
        const applied = await session.commitSourceEdit(
          (current) => {
            if (current !== before) throw new ReflectError('io', 'This note changed while saving.')
            return source
          },
          (saved) => {
            savedSource = saved
          },
        )
        if (!applied) throw new Error('This note cannot be edited right now.')
        return savedSource
      } else await writeNote(path, source, generation, before)
    },
    checkpoint,
    failure(path, _error, retry) {
      if (!active || failures.has(path)) return
      failures.add(path)
      toast.add({
        id: `task-save:${key}:${path}`,
        type: 'error',
        title: "Couldn't save tasks. Your changes are kept.",
        actionProps: {
          children: 'Retry',
          onClick: () => {
            failures.delete(path)
            retry()
          },
        },
      })
    },
    saved(path) {
      failures.delete(path)
      toast.close(`task-save:${key}:${path}`)
    },
  })
  controllers.set(key, controller)
  const unregister = registerPendingWriter(controller.flush)
  retirements.set(key, async () => {
    await controller.flush()
    await Promise.allSettled(journals.values())
    active = false
    unregister()
    controllers.delete(key)
    retirements.delete(key)
    for (const path of failures) toast.close(`task-save:${key}:${path}`)
  })
  const ready = readTaskJournal(root)
    .then((entries) => {
      for (const entry of entries) controller.restore(entry.path, entry.commands, entry.attempt)
    })
    .catch((error: unknown) => {
      console.error('Reading task drafts failed:', error)
      toast.add({ type: 'error', title: 'Saved task drafts could not be loaded.' })
    })
  return controller
}
