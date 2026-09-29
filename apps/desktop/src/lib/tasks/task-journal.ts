import { getCurrentWindow } from '@tauri-apps/api/window'
import { isNativeShell } from '@/lib/platform.ts'
import { z } from 'zod'
import type { TaskAttempt, TaskCommand } from '@reflect/core'

const rowSchema = z.object({
  inTasksView: z.boolean().optional(),
  taskId: z.string().optional(),
  notePath: z.string(),
  revision: z.string().optional(),
  astPath: z.array(z.number()).optional(),
  sortPath: z.array(z.number()).optional(),
  text: z.string(),
  displayText: z.string(),
  checked: z.boolean(),
  dueDate: z.string().nullable(),
  breadcrumbs: z.array(z.string()),
  noteTitle: z.string(),
  dailyDate: z.string().nullable(),
  isPinned: z.boolean(),
  pinnedOrder: z.number().nullable(),
  updatedAt: z.number(),
})
const commandSchema = z.object({
  id: z.string(),
  row: rowSchema,
  after: z.string().optional(),
  edit: z.object({
    text: z.string().optional(),
    checked: z.boolean().optional(),
    dueDate: z.string().nullable().optional(),
    remove: z.boolean().optional(),
    toBullet: z.boolean().optional(),
  }),
})
const entrySchema = z.object({
  root: z.string(),
  owner: z.string(),
  path: z.string(),
  commands: z.array(commandSchema),
  attempt: z
    .object({ before: z.string().nullable(), source: z.string(), commands: z.array(commandSchema) })
    .nullable(),
})

function openJournal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('reflect-task-drafts', 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore('notes', { keyPath: ['root', 'owner', 'path'] })
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

function journalOwner(): string {
  // Tauri window labels survive a webview reload and isolate simultaneous writers.
  if (isNativeShell()) return getCurrentWindow().label
  let owner = sessionStorage.getItem('reflect.task-journal-owner')
  if (!owner) {
    owner = crypto.randomUUID()
    sessionStorage.setItem('reflect.task-journal-owner', owner)
  }
  return owner
}

/** Read only committed drafts; empty placeholders never enter this database. */
export async function readTaskJournal(root: string) {
  const database = await openJournal()
  try {
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction('notes').objectStore('notes').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return values
      .map((value) => entrySchema.parse(value))
      .filter((entry) => entry.root === root && entry.owner === journalOwner())
  } finally {
    database.close()
  }
}

/** Atomically checkpoint a note's submitted commands and in-flight attempt. */
export async function writeTaskJournal(
  root: string,
  path: string,
  commands: readonly TaskCommand[],
  attempt: TaskAttempt | null,
): Promise<void> {
  const database = await openJournal()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('notes', 'readwrite')
      const store = transaction.objectStore('notes')
      if (commands.length > 0) store.put({ root, owner: journalOwner(), path, commands, attempt })
      else store.delete([root, journalOwner(), path])
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}
