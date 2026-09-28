import type { TaskAddress } from '@reflect/core'

export const TASK_WRITES_UNAVAILABLE =
  'Task editing is temporarily unavailable. Edit the task in its note.'

/** Aggregate task writes resume when the AST mutation layer is connected. */
async function unavailable(): Promise<never> {
  throw new Error(TASK_WRITES_UNAVAILABLE)
}

export const toggleTask: (task: TaskAddress, generation: number) => Promise<void> = unavailable
export const editTask: (task: TaskAddress, content: string, generation: number) => Promise<void> =
  unavailable
export const deleteTask: (task: TaskAddress, generation: number) => Promise<void> = unavailable
export const convertTaskToBullet: (task: TaskAddress, generation: number) => Promise<void> =
  unavailable
export const insertTask: (notePath: string, generation: number) => Promise<TaskAddress> =
  unavailable
