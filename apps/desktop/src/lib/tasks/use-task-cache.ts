import { useEffect } from 'react'
import { onTaskMutation } from '@/lib/note-task.ts'
import { relocateRecentlyCompleted } from './recently-completed.ts'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { errorMessage, inlineMarkdownToDisplayText, parseNote, type OpenTask } from '@reflect/core'
import { startOperation } from '@/lib/operations.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { sameTask } from '@/lib/tasks/task-identity.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

const versions = new WeakMap<QueryClient, number>()
const subscriptions = new WeakMap<
  QueryClient,
  Map<number, { count: number; unsubscribe: () => void }>
>()
function subscribeTaskCache(
  queryClient: QueryClient,
  root: string,
  generation: number,
): () => void {
  let clients = subscriptions.get(queryClient)
  if (!clients) {
    clients = new Map()
    subscriptions.set(queryClient, clients)
  }
  let subscription = clients.get(generation)
  if (!subscription) {
    const openKey = queryKeys.index.openTasks(root)
    const completedKey = queryKeys.index.completedTasks(root)
    subscription = {
      count: 0,
      unsubscribe: onTaskMutation((receipt) => {
        if (receipt.generation !== generation) return
        versions.set(queryClient, (versions.get(queryClient) ?? 0) + 1)
        const open = queryClient.getQueryData<OpenTask[]>(openKey) ?? []
        const completed = queryClient.getQueryData<OpenTask[]>(completedKey) ?? []
        const context = [...open, ...completed].find((task) => task.notePath === receipt.notePath)
        if (
          !context ||
          (context.revision !== receipt.beforeRevision && context.revision !== receipt.revision)
        )
          return
        const referenceMarkdown = parseNote({
          path: receipt.notePath,
          source: receipt.source,
        }).referenceMarkdown
        const projected = receipt.tasks.map((task) => ({
          ...context,
          ...task,
          revision: receipt.revision,
          referenceMarkdown,
          text: inlineMarkdownToDisplayText(task.firstParagraphMarkdown),
          updatedAt: Date.now(),
        }))
        queryClient.setQueryData<OpenTask[]>(openKey, (rows) => [
          ...(rows ?? []).filter((row) => row.notePath !== receipt.notePath),
          ...projected.filter((task) => !task.checked),
        ])
        queryClient.setQueryData<OpenTask[]>(completedKey, (rows) =>
          rows === undefined
            ? undefined
            : [
                ...rows.filter((row) => row.notePath !== receipt.notePath),
                ...projected.filter((task) => task.checked),
              ],
        )
        relocateRecentlyCompleted(root, receipt, projected)
      }),
    }
    clients.set(generation, subscription)
  }
  subscription.count++
  const current = subscription
  return () => {
    if (--current.count === 0) {
      current.unsubscribe()
      clients.delete(generation)
    }
  }
}

/** Updates a cached task list in place; returning the same `undefined` is a no-op. */
type TaskListPatch = (rows: OpenTask[] | undefined) => OpenTask[] | undefined

/** The open + completed task lists captured before an optimistic write, for rollback. */
export interface TaskCacheSnapshot {
  version: number
  open: OpenTask[] | undefined
  completed: OpenTask[] | undefined
}

export interface TaskCacheWriter {
  /** Cancel in-flight refetches and capture both lists so a failed write can roll back. */
  snapshot: () => Promise<TaskCacheSnapshot>
  /** Optimistically rewrite the open and completed lists at once. */
  patch: (open: TaskListPatch, completed: TaskListPatch) => void
  /** Add an open row and remove the same address from completed rows. */
  addOpen: (task: OpenTask) => void
  /** Restore both lists from a snapshot and surface the failure once (single-write undo). */
  rollback: (captured: TaskCacheSnapshot | undefined, label: string, cause: unknown) => void
  /**
   * Refetch both lists from the index and surface the failure once. For a **batch**
   * where some writes may have already landed, restoring the pre-batch snapshot
   * would wrongly un-do the persisted ones (and could clobber a fresher reindex);
   * invalidating reconciles the cache to disk truth instead.
   */
  reconcile: (label: string, cause: unknown) => void
}

/**
 * Shared optimistic write/rollback for the two task caches — the open list and
 * the completed ("archived") list — keyed on the active graph. Every Tasks-view
 * mutation (single-row checkbox, bulk complete, delete, inline edit) goes
 * through the same snapshot → patch → rollback path, so the optimistic shapes
 * (see {@link withoutTasks}/{@link asCompleted}/{@link asOpen}/{@link withEditedTask}) can't
 * drift between the single-row and bulk code paths.
 *
 * `patch` mirrors a change across BOTH lists; a list that isn't loaded (the
 * completed list with archived off) stays untouched when its patch returns the
 * same `undefined`. `rollback` restores the captured lists and raises one
 * operations toast labelled for the action.
 */
export function useTaskCacheWriter(): TaskCacheWriter {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const openKey = queryKeys.index.openTasks(graph?.root)
  const completedKey = queryKeys.index.completedTasks(graph?.root)

  useEffect(
    () => (graph ? subscribeTaskCache(queryClient, graph.root, graph.generation) : undefined),
    [queryClient, graph?.root, graph?.generation],
  )

  const snapshot = async (): Promise<TaskCacheSnapshot> => {
    await queryClient.cancelQueries({ queryKey: openKey })
    await queryClient.cancelQueries({ queryKey: completedKey })
    const version = (versions.get(queryClient) ?? 0) + 1
    versions.set(queryClient, version)
    return {
      version,
      open: queryClient.getQueryData<OpenTask[]>(openKey),
      completed: queryClient.getQueryData<OpenTask[]>(completedKey),
    }
  }

  const patch = (open: TaskListPatch, completed: TaskListPatch): void => {
    queryClient.setQueryData<OpenTask[]>(openKey, open)
    queryClient.setQueryData<OpenTask[]>(completedKey, completed)
  }

  const addOpen = (task: OpenTask): void => {
    patch(
      (rows) => [...(rows ?? []).filter((row) => !sameTask(row, task)), task],
      (rows) => rows?.filter((row) => !sameTask(row, task)),
    )
  }

  const rollback = (
    captured: TaskCacheSnapshot | undefined,
    label: string,
    cause: unknown,
  ): void => {
    if (captured && captured.version !== versions.get(queryClient)) {
      reconcile(label, cause)
      return
    }
    if (captured?.open !== undefined) {
      queryClient.setQueryData(openKey, captured.open)
    }
    if (captured?.completed !== undefined) {
      queryClient.setQueryData(completedKey, captured.completed)
    }
    startOperation(label).fail(errorMessage(cause))
  }

  const reconcile = (label: string, cause: unknown): void => {
    void queryClient.invalidateQueries({ queryKey: openKey })
    void queryClient.invalidateQueries({ queryKey: completedKey })
    startOperation(label).fail(errorMessage(cause))
  }

  return { snapshot, patch, addOpen, rollback, reconcile }
}
