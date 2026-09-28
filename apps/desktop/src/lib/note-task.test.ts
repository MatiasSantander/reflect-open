import { describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import {
  toggleTask,
  editTask,
  deleteTask,
  convertTaskToBullet,
  insertTask,
  TASK_WRITES_UNAVAILABLE,
} from './note-task.ts'

describe('aggregate task writes', () => {
  it('refuses before reading or writing a note', async () => {
    const invoke = vi.fn()
    setBridge({ invoke, listen: async () => () => {} })
    const task = { notePath: 'notes/n.md', revision: 'hash', astPath: [0] }
    for (const operation of [
      toggleTask(task, 1),
      editTask(task, 'changed', 1),
      deleteTask(task, 1),
      convertTaskToBullet(task, 1),
      insertTask(task.notePath, 1),
    ]) {
      await expect(operation).rejects.toThrow(TASK_WRITES_UNAVAILABLE)
    }
    expect(invoke).not.toHaveBeenCalled()
  })
})
