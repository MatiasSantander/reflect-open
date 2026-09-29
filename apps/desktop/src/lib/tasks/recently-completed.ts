import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { TaskListItem } from '@reflect/core'
import { taskKey } from '@/lib/tasks/task-identity.ts'

/**
 * The "recently completed" set (Plan 18) — V1's middle state where a checked task
 * keeps showing (struck) in the list until you archive it. It's deliberately a
 * **view-only, ephemeral** set, not durable state: a checked task is already
 * `[x]` on disk, and "archived" only means "stop showing it in the active list",
 * which the markdown can't (and shouldn't) encode. So it resets on app restart;
 * it survives navigating away from Tasks and back (a module singleton, above any
 * one screen mount).
 *
 * Tracking the session's completions — rather than every `[x]` task — is what
 * keeps a fresh launch clean: only what you checked *this run* lingers struck;
 * the whole historical pile stays behind the "show archived" filter.
 *
 * The set yields to the index when it disagrees: a task reopened at its source
 * note (the checkbox flipped back to `[ ]` in the editor) comes back through the
 * open-tasks read, and {@link reconcileRecentlyCompleted} drops the struck copy
 * so the live row shows instead of a stale `[x]` shadow.
 *
 * Scoped to a graph root: switching graphs (whose task paths differ) yields an
 * empty set rather than the previous graph's rows.
 */

const EMPTY: readonly TaskListItem[] = []
let graphRoot: string | null = null
let tasks: readonly TaskListItem[] = EMPTY
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Switch the active graph, discarding any other graph's set. */
function adopt(root: string | null): void {
  if (root !== graphRoot) {
    graphRoot = root
    tasks = EMPTY
  }
}

/**
 * Keep `completed` showing struck (checked) in the active list until archived.
 * Stored as a fresh checked copy, deduped by {@link taskKey}. The marker in `raw`
 * is flipped to `[x]` to match disk — these rows outlive the reindex, so a stale
 * `[ ]` would later fail the reopen/edit/delete write-back .
 */
export function markRecentlyCompleted(root: string | null, completed: readonly TaskListItem[]): void {
  if (completed.length === 0) {
    return
  }
  adopt(root)
  const byKey = new Map(tasks.map((task) => [taskKey(task), task]))
  for (const task of completed) {
    byKey.set(taskKey(task), { ...task, checked: true })
  }
  tasks = [...byKey.values()]
  emit()
}

/** Drop these keys — a completion rolled back, or the task was deleted. */
export function forgetRecentlyCompleted(root: string | null, keys: readonly string[]): void {
  if (root !== graphRoot || keys.length === 0) {
    return
  }
  const drop = new Set(keys)
  const next = tasks.filter((task) => !drop.has(taskKey(task)))
  if (next.length !== tasks.length) {
    tasks = next
    emit()
  }
}

/** Whether a task is currently being kept visible by the session's struck set. */
export function hasRecentlyCompleted(root: string | null, key: string): boolean {
  return root === graphRoot && tasks.some((task) => taskKey(task) === key)
}

/**
 * The struck rows not superseded by a live open row — the pure core of the
 * reconciliation, shared by the store prune ({@link reconcileRecentlyCompleted})
 * and the render-time view in {@link useRecentlyCompleted}. A struck task the
 * index reports open again with a **newer** `updatedAt` was reopened at the
 * source note — its file was rewritten and reindexed since we completed it — so
 * the struck copy is dropped and the live open row shows instead of a stale
 * `[x]` shadow (whose reopen write-back would fail: the `[x]` line is no longer
 * in the note). An open row with an *unchanged* `updatedAt` is the
 * pre-completion index state — a refetch racing the completion's reindex — and
 * keeps its shadow, so a just-checked row can't flicker back to open. Returns
 * the input array itself when nothing is dropped, so callers can compare by
 * reference.
 */
function withoutReopened(
  struck: readonly TaskListItem[],
  open: readonly TaskListItem[],
): readonly TaskListItem[] {
  if (struck.length === 0 || open.length === 0) {
    return struck
  }
  const liveByKey = new Map(open.map((row) => [taskKey(row), row]))
  const next = struck.filter((task) => {
    const live = liveByKey.get(taskKey(task))
    return live === undefined || live.updatedAt <= task.updatedAt
  })
  return next.length === struck.length ? struck : next
}

/**
 * Reconcile the struck set against a fresh open-tasks read, dropping every
 * struck copy whose task was reopened at its source note ({@link
 * withoutReopened}) — so `hasRecentlyCompleted` and the Archive count agree
 * with what the surfaces render.
 */
export function reconcileRecentlyCompleted(root: string | null, open: readonly TaskListItem[]): void {
  if (root !== graphRoot) {
    return
  }
  const next = withoutReopened(tasks, open)
  if (next !== tasks) {
    tasks = next
    emit()
  }
}

/** Archive: stop showing the session's completed tasks (they stay `[x]` on disk). */
export function archiveRecentlyCompleted(root: string | null): void {
  adopt(root)
  if (tasks.length > 0) {
    tasks = EMPTY
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The session's recently-completed tasks for `root` (empty for any other graph),
 * reconciled against the live open-tasks read: passing the open query's data in
 * is what lets a task reopened at its source note shed its struck shadow, so
 * every surface that renders the set gets that reconciliation for free.
 *
 * The returned view filters superseded rows **during render** — the very first
 * render with the fresh open data already shows the live row, leaving no frame
 * where the stale `[x]` shadow could still offer a doomed Reopen. The store
 * itself is pruned in an effect ({@link reconcileRecentlyCompleted}) so
 * `hasRecentlyCompleted` and the Archive count catch up right after.
 */
export function useRecentlyCompleted(
  root: string | null,
  open: readonly TaskListItem[] | undefined,
): readonly TaskListItem[] {
  useEffect(() => {
    if (open !== undefined) {
      reconcileRecentlyCompleted(root, open)
    }
  }, [root, open])
  const getSnapshot = useCallback(() => (root === graphRoot ? tasks : EMPTY), [root])
  const struck = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo(
    () => (open === undefined ? struck : withoutReopened(struck, open)),
    [struck, open],
  )
}

/** Test-only: clear the singleton between cases. */
export function resetRecentlyCompleted(): void {
  graphRoot = null
  tasks = EMPTY
  emit()
}
