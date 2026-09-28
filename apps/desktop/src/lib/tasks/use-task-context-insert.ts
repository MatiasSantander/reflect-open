import type { OpenTask } from '@reflect/core'
import { TASK_WRITES_UNAVAILABLE } from '@/lib/note-task.ts'

export interface TaskContextInsert {
  readonly insert: (task: OpenTask, content: string | null) => Promise<OpenTask | null>
  readonly isPending: boolean
}

/** Contextual insertion waits for the AST mutation layer. */
export function taskContextInsert(): TaskContextInsert {
  return {
    isPending: false,
    insert: async () => {
      throw new Error(TASK_WRITES_UNAVAILABLE)
    },
  }
}
