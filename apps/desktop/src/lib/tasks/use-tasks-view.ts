import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { TaskListItem } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider.tsx'
import { taskController } from './task-controller.ts'

const emptySubscribe = () => () => {}
const emptySnapshot = () => 0

/** Compose index results with submitted edits and in-memory placeholders. */
export function useTasksView(
  open: TaskListItem[] | undefined,
  completed: TaskListItem[] | undefined,
) {
  const { graph } = useGraph()
  const controller = useMemo(
    () => (graph ? taskController(graph.root, graph.generation) : null),
    [graph?.root, graph?.generation],
  )
  const version = useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.snapshot ?? emptySnapshot,
  )
  useEffect(() => {
    void controller?.reconcile()
  }, [controller, open, completed])
  return useMemo(
    () => ({
      open: open === undefined ? undefined : (controller?.project(open, false) ?? open),
      completed:
        completed === undefined ? undefined : (controller?.project(completed, true) ?? completed),
    }),
    [controller, version, open, completed],
  )
}
