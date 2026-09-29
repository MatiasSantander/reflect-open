import { TaskController, readNote, writeNote, isAppError, ReflectError } from '@reflect/core'
import { openSession, registerPendingWriter } from '@/editor/open-documents.ts'
import { toast } from '@/components/ui/toast.tsx'

const controllers = new Map<string, TaskController>()
const retirements = new Map<string, () => Promise<void>>()

/** Finish every graph's pending task writes and release the writers. */
export async function retireTaskControllers(): Promise<void> {
  await Promise.all([...retirements.values()].map((retire) => retire()))
}

/**
 * The task writer of one graph session, shared by every task surface. Reads
 * and writes go through the note's live `NoteSession` when it is open in an
 * editor, so unsaved editor content is preserved, and through the file
 * otherwise. Save failures show one toast per note with a Retry action.
 */
export function taskController(root: string, generation: number): TaskController {
  const key = JSON.stringify([root, generation])
  const existing = controllers.get(key)
  if (existing) return existing
  let active = true
  const assertActive = () => {
    if (!active) throw new Error('This graph session has closed.')
  }
  const failures = new Set<string>()
  const toastId = (path: string) => `task-save:${key}:${path}`
  const controller = new TaskController({
    async read(path) {
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
      if (!session) {
        await writeNote(path, source, generation, before)
        return
      }
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
    },
    failure(path, _error, retry) {
      if (!active || failures.has(path)) return
      failures.add(path)
      toast.add({
        id: toastId(path),
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
      toast.close(toastId(path))
    },
  })
  controllers.set(key, controller)
  const unregister = registerPendingWriter(controller.flush)
  retirements.set(key, async () => {
    await controller.flush()
    active = false
    unregister()
    controllers.delete(key)
    retirements.delete(key)
    for (const path of failures) toast.close(toastId(path))
  })
  return controller
}
