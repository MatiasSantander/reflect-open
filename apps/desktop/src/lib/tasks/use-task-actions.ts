import { keepTaskDraft } from './task-drafts.ts'
import { useMutation } from '@tanstack/react-query'
import type { OpenTask, TaskAddress } from '@reflect/core'
import { continueTaskInContext, mutateTasks, editTask, insertTask } from '@/lib/note-task.ts'
import { mutationKeys } from '@/lib/query-client.ts'
import {
  archiveRecentlyCompleted,
  forgetRecentlyCompleted,
  hasRecentlyCompleted,
  markRecentlyCompleted,
} from '@/lib/tasks/recently-completed.ts'
import { scheduledContent } from '@/lib/tasks/task-schedule-content.ts'
import { asCompleted, asOpen, withEditedTask, withoutTasks } from '@/lib/tasks/task-cache.ts'
import { taskKey } from '@/lib/tasks/task-identity.ts'
import { insertedTaskRow, type InsertTaskTarget } from '@/lib/tasks/task-insert-target.ts'
import { useTaskCheckboxAction } from '@/lib/tasks/use-task-checkbox-action.ts'
import { useTaskCacheWriter } from '@/lib/tasks/use-task-cache.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Bulk task actions for the Tasks view's keyboard shortcuts (Plan 18): complete
 * a selection (⌘↵), delete a selection (⌫/⌘⌫), edit one task from the inline
 * editor, and add a task (Return). They update the open and completed caches
 * optimistically through the shared {@link useTaskCacheWriter} — the same path
 * single-row checkbox toggle takes — so the selection reacts instantly,
 * then the reindex reconciles. A failed write rolls every row back and surfaces
 * the reason once.
 */
export interface TaskActions {
  complete: (tasks: OpenTask[]) => void
  /**
   * ⌘↵ on a selection (V1's `toggleChecked`): complete the open rows, or — when
   * every selected row is already checked — reopen them all. So a just-completed
   * row (still struck) can be un-done with the same chord.
   */
  toggle: (tasks: OpenTask[]) => void
  remove: (tasks: OpenTask[]) => void
  /** Replace one task's content from the inline editor (Plan 18). */
  edit: (task: OpenTask, content: string) => void
  /** Toggle one row checkbox with exact rollback semantics for inline-editor checkbox clicks. */
  checkboxToggle: (task: OpenTask) => void
  /**
   * Add a new empty task to `target`'s note (Return-to-add, V1) and return the
   * optimistic row to select — its inline editor opens focused. Resolves to
   * `null` when there's no graph or the write failed (the toast already fired).
   */
  insert: (target: InsertTaskTarget) => Promise<OpenTask | null>
  /**
   * Enter while editing (V1 continuous entry): persist the current row's edit
   * (when `content` isn't null), then add the next task in `target` and return it
   * to select. A task with breadcrumb context is continued structurally inside
   * that context; other tasks retain the V1 bucket-target behavior.
   */
  insertAfter: (
    task: OpenTask,
    content: string | null,
    target: InsertTaskTarget,
  ) => Promise<OpenTask | null>
  /**
   * Save the paragraph and checkbox state in one revision-checked write.
   */
  editAndToggle: (task: OpenTask, content: string) => void
  /**
   * Schedule a selection (⌘⇧S / the calendar, V1): set each task's due date to
   * `isoDate`, or clear it when `isoDate` is null. Written as a content edit that
   * adds/replaces the `[[YYYY-MM-DD]]` link the projection reads as the due date.
   */
  schedule: (tasks: OpenTask[], isoDate: string | null) => void
  /**
   * Convert a selection to plain bullets (⌘⇧K, V1's "Convert to checklist"
   * restated for markdown): strip each task's `[ ]`/`[x]` marker so it leaves
   * the Tasks view but stays in its note as an ordinary list item.
   */
  convertToBullet: (tasks: OpenTask[]) => void
  /**
   * Save the paragraph and convert the item in one revision-checked write.
   */
  editAndConvertToBullet: (task: OpenTask, content: string) => void
  /** Archive (⌘⇧↵): stop showing the session's completed tasks in the active list. */
  archive: () => void
  isPending: boolean
}

export function useTaskActions(): TaskActions {
  const { graph } = useGraph()
  const root = graph?.root ?? null
  const cache = useTaskCacheWriter()
  const checkboxAction = useTaskCheckboxAction()

  const completeMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot),
    mutationKey: mutationKeys.tasks.complete(graph?.root),
    mutationFn: async ({ tasks, generation }: { tasks: OpenTask[]; generation: number }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return await mutateTasks(
        tasks.map((task) => ({ task, edit: { checked: true } })),
        generation,
      )
    },
    onMutate: async ({ tasks }: { tasks: OpenTask[]; generation: number }) => {
      const snapshot = await cache.snapshot()
      // Drop the completed rows from the open list, and (when archived is on)
      // prepend them as checked to the completed list so they stay visible struck.
      cache.patch(
        (rows) => withoutTasks(rows, tasks),
        (rows) => asCompleted(rows, tasks),
      )
      // Keep them showing struck (V1's middle state) until archived.
      markRecentlyCompleted(root, tasks)
      return snapshot
    },
    onError: (cause, { tasks }) => {
      // A batch can fail after earlier writes landed — refetch truth rather than
      // restore a snapshot that would un-do the ones that persisted.
      cache.reconcile('Completing tasks', cause)
      forgetRecentlyCompleted(root, tasks.map(taskKey))
    },
  })

  const reopenMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot),
    mutationKey: mutationKeys.tasks.reopen(graph?.root),
    mutationFn: async ({ tasks, generation }: { tasks: OpenTask[]; generation: number }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return await mutateTasks(
        tasks.map((task) => ({ task, edit: { checked: false } })),
        generation,
      )
    },
    onMutate: async ({ tasks }: { tasks: OpenTask[]; generation: number }) => {
      const snapshot = await cache.snapshot()
      // Put them back in the open list (unchecked), drop them from the completed
      // list and this session's struck set — the inverse of completing.
      cache.patch(
        (rows) => asOpen(rows, tasks),
        (rows) => withoutTasks(rows, tasks),
      )
      forgetRecentlyCompleted(root, tasks.map(taskKey))
      return snapshot
    },
    onError: (cause) => cache.reconcile('Reopening tasks', cause),
  })

  const deleteMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot),
    mutationKey: mutationKeys.tasks.delete(graph?.root),
    mutationFn: async ({ tasks, generation }: { tasks: OpenTask[]; generation: number }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return await mutateTasks(
        tasks.map((task) => ({ task, edit: { remove: true } })),
        generation,
      )
    },
    onMutate: async ({ tasks }: { tasks: OpenTask[]; generation: number }) => {
      const snapshot = await cache.snapshot()
      // A delete removes the task from both lists outright.
      cache.patch(
        (rows) => withoutTasks(rows, tasks),
        (rows) => withoutTasks(rows, tasks),
      )
      // A deleted task must not linger struck in the session's completed set.
      forgetRecentlyCompleted(root, tasks.map(taskKey))
      return snapshot
    },
    onError: (cause, { tasks }) => {
      cache.reconcile('Deleting tasks', cause)
      // The delete dropped checked rows from the session's struck set; if it
      // failed they're still `[x]` on disk, so restore them or they'd vanish from
      // the default list (gone from open, struck-set, and the unloaded archived query).
      markRecentlyCompleted(
        root,
        tasks.filter((task) => task.checked),
      )
    },
  })

  const editMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot),
    mutationKey: mutationKeys.tasks.edit(graph?.root),
    mutationFn: ({
      task,
      content,
      generation,
    }: {
      task: OpenTask
      content: string
      generation: number
    }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return editTask(task, content, generation)
    },
    onMutate: async ({
      task,
      content,
    }: {
      task: OpenTask
      content: string
      generation: number
    }) => {
      const snapshot = await cache.snapshot()
      // Show the new text in both lists before the reindex; the row keeps its
      // place until the index re-derives any due date (see withEditedTask).
      cache.patch(
        (rows) => withEditedTask(rows, task, content),
        (rows) => withEditedTask(rows, task, content),
      )
      return snapshot
    },
    onError: (cause, { task, content, generation }, context) => {
      keepTaskDraft(task, content, generation)
      cache.rollback(context, 'Editing task', cause)
    },
  })

  const scheduleMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot),
    mutationKey: mutationKeys.tasks.schedule(graph?.root),
    mutationFn: async ({
      tasks,
      isoDate,
      generation,
    }: {
      tasks: OpenTask[]
      isoDate: string | null
      generation: number
    }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return await mutateTasks(
        tasks.map((task) => ({
          task,
          edit: { text: scheduledContent(task, isoDate) },
        })),
        generation,
      )
    },
    onMutate: async ({
      tasks,
      isoDate,
    }: {
      tasks: OpenTask[]
      isoDate: string | null
      generation: number
    }) => {
      const snapshot = await cache.snapshot()
      // Show the new date link in place; the row only changes bucket once the
      // reindex re-derives the due date (V1 likewise defers the move).
      const patch = (rows: OpenTask[] | undefined): OpenTask[] | undefined =>
        tasks.reduce<OpenTask[] | undefined>(
          (acc, task) => withEditedTask(acc, task, scheduledContent(task, isoDate)),
          rows,
        )
      cache.patch(patch, patch)
      return snapshot
    },
    onError: (cause) => cache.reconcile('Scheduling tasks', cause),
  })

  const convertMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot),
    mutationKey: mutationKeys.tasks.convert(graph?.root),
    mutationFn: async ({ tasks, generation }: { tasks: OpenTask[]; generation: number }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return await mutateTasks(
        tasks.map((task) => ({ task, edit: { toBullet: true } })),
        generation,
      )
    },
    onMutate: async ({ tasks }: { tasks: OpenTask[]; generation: number }) => {
      const snapshot = await cache.snapshot()
      // A converted task is no longer a checkbox, so it leaves both lists outright
      // — same optimistic shape as a delete.
      cache.patch(
        (rows) => withoutTasks(rows, tasks),
        (rows) => withoutTasks(rows, tasks),
      )
      // A converted task must not linger struck in the session's completed set.
      forgetRecentlyCompleted(root, tasks.map(taskKey))
      return snapshot
    },
    onError: (cause, { tasks }) => {
      cache.reconcile('Converting tasks', cause)
      // The convert dropped checked rows from the session's struck set; if it
      // failed they're still `[x]` on disk, so restore them or they'd vanish from
      // the default list (gone from open, struck-set, and the unloaded archived query).
      markRecentlyCompleted(
        root,
        tasks.filter((task) => task.checked),
      )
    },
  })

  const editAndConvertMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot),
    mutationKey: mutationKeys.tasks.editAndConvert(graph?.root),
    mutationFn: async ({
      task,
      content,
      generation,
    }: {
      task: OpenTask
      content: string
      generation: number
    }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return await mutateTasks([{ task, edit: { text: content, toBullet: true } }], generation)
    },
    onMutate: async ({ task }: { task: OpenTask; content: string; generation: number }) => {
      const snapshot = await cache.snapshot()
      // The row leaves the view (it's no longer a checkbox) — same optimistic shape
      // as a plain convert.
      cache.patch(
        (rows) => withoutTasks(rows, [task]),
        (rows) => withoutTasks(rows, [task]),
      )
      forgetRecentlyCompleted(root, [taskKey(task)])
      return snapshot
    },
    onError: (cause, { task, content, generation }) => {
      keepTaskDraft(task, content, generation)
      cache.reconcile('Converting task', cause)
    },
  })

  const insertMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (result) => cache.apply(result.receipts),
    mutationKey: mutationKeys.tasks.insert(graph?.root),
    mutationFn: ({ target, generation }: { target: InsertTaskTarget; generation: number }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return insertTask(target.notePath, generation)
    },
    onError: (cause) => cache.reconcile('Adding task', cause),
  })

  const editAndToggleMutation = useMutation({
    scope: { id: 'tasks' },
    onSuccess: (receipts, _variables, snapshot) => cache.apply(receipts, snapshot?.snapshot),
    mutationKey: mutationKeys.tasks.editAndToggle(graph?.root),
    mutationFn: async ({
      task,
      content,
      generation,
    }: {
      task: OpenTask
      content: string
      generation: number
    }) => {
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return await mutateTasks(
        [{ task, edit: { text: content, checked: !task.checked } }],
        generation,
      )
    },
    onMutate: async ({
      task,
      content,
    }: {
      task: OpenTask
      content: string
      generation: number
    }) => {
      const snapshot = await cache.snapshot()
      const edited = withEditedTask([task], task, content)?.[0] ?? task
      const wasRecentlyCompleted = hasRecentlyCompleted(root, taskKey(task))
      if (task.checked) {
        cache.patch(
          (rows) => asOpen(rows, [edited]),
          (rows) => withoutTasks(rows, [task]),
        )
        forgetRecentlyCompleted(root, [taskKey(task)])
      } else {
        // Surface the *edited* row struck (its new text), in both the completed
        // cache (archived on) and the session set (off) — not the pre-edit task.
        cache.patch(
          (rows) => withoutTasks(rows, [task]),
          (rows) => asCompleted(rows, [edited]),
        )
        markRecentlyCompleted(root, [edited])
      }
      return { snapshot, wasRecentlyCompleted }
    },
    onError: (cause, { task, content, generation }, context) => {
      keepTaskDraft(task, content, generation)
      cache.reconcile(task.checked ? 'Reopening task' : 'Completing task', cause)
      if (task.checked && context?.wasRecentlyCompleted) {
        markRecentlyCompleted(root, [task])
      } else if (!task.checked) {
        forgetRecentlyCompleted(root, [taskKey(task)])
      }
    },
  })

  const continueMutation = useMutation({
    scope: { id: 'tasks' },
    mutationKey: [...mutationKeys.tasks.insert(graph?.root), 'continue'],
    mutationFn: ({
      task,
      content,
      generation,
    }: {
      task: OpenTask
      content: string | null
      generation: number
    }) => {
      if (generation === undefined) throw new Error('No graph is open.')
      return continueTaskInContext(task, content, generation)
    },
    onSuccess: (result) => cache.apply(result.receipts),
    onError: (cause, { task, content, generation }) => {
      if (content !== null) keepTaskDraft(task, content, generation)
      cache.reconcile('Adding task', cause)
    },
  })

  async function persistTaskDraft(task: OpenTask, content: string | null): Promise<boolean> {
    const generation = graph?.generation
    if (generation === undefined) return false
    try {
      if (content === '') {
        await deleteMutation.mutateAsync({ tasks: [task], generation })
      } else if (content !== null) {
        await editMutation.mutateAsync({ task, content, generation })
      }
      return true
    } catch {
      return false
    }
  }
  return {
    isPending:
      continueMutation.isPending ||
      completeMutation.isPending ||
      reopenMutation.isPending ||
      deleteMutation.isPending ||
      editMutation.isPending ||
      editAndToggleMutation.isPending ||
      checkboxAction.isPending ||
      insertMutation.isPending ||
      scheduleMutation.isPending ||
      convertMutation.isPending ||
      editAndConvertMutation.isPending,
    complete: (tasks) => {
      // ⌘↵ *completes*; with archived rows in the selection, toggling an
      // already-checked task would reopen it on disk. Only act on open rows.
      const open = tasks.filter((task) => !task.checked)
      if (open.length > 0 && graph?.generation !== undefined && !completeMutation.isPending) {
        completeMutation.mutate({ tasks: open, generation: graph.generation })
      }
    },
    toggle: (tasks) => {
      if (tasks.length === 0 || graph?.generation === undefined) {
        return
      }
      // V1: all checked → reopen them all; otherwise complete the open ones.
      if (tasks.every((task) => task.checked)) {
        if (!reopenMutation.isPending) {
          reopenMutation.mutate({ tasks: tasks, generation: graph.generation })
        }
      } else {
        const open = tasks.filter((task) => !task.checked)
        if (open.length > 0 && !completeMutation.isPending) {
          completeMutation.mutate({ tasks: open, generation: graph.generation })
        }
      }
    },
    remove: (tasks) => {
      if (tasks.length > 0 && graph?.generation !== undefined && !deleteMutation.isPending) {
        deleteMutation.mutate({ tasks: tasks, generation: graph.generation })
      }
    },
    edit: (task, content) => {
      if (graph?.generation !== undefined) {
        editMutation.mutate({ task, content, generation: graph.generation })
      }
    },
    checkboxToggle: (task) => checkboxAction.toggle(task),
    insert: async (target) => {
      if (graph?.generation === undefined) {
        return null
      }
      let address: TaskAddress
      try {
        address = await insertMutation.mutateAsync({ target, generation: graph.generation })
      } catch {
        return null // reconcile already surfaced the failure
      }
      const created = insertedTaskRow(target, address)
      cache.addOpen(created)
      return created
    },
    insertAfter: async (task, content, target) => {
      if (graph?.generation === undefined) {
        return null
      }
      if (task.breadcrumbs.length > 0) {
        try {
          const address = await continueMutation.mutateAsync({
            task,
            content,
            generation: graph.generation,
          })
          const created = insertedTaskRow(target, address, task.breadcrumbs)
          cache.addOpen(created)
          return created
        } catch {
          return null
        }
      }
      // Resolve the current row first and *await* it, so the append reads the
      // settled source.
      // Emptied content (the row was cleared) deletes that row rather than leaving
      // a bare `+ [ ]` ghost; a real change persists; null (unchanged) is left be.
      if (!(await persistTaskDraft(task, content))) {
        return null // the edit/delete rollback already surfaced the failure
      }
      let address: TaskAddress
      try {
        address = await insertMutation.mutateAsync({ target, generation: graph.generation })
      } catch {
        return null
      }
      const created = insertedTaskRow(target, address)
      cache.addOpen(created)
      return created
    },
    editAndToggle: (task, content) => {
      if (graph?.generation !== undefined && !editAndToggleMutation.isPending) {
        editAndToggleMutation.mutate({ task, content, generation: graph.generation })
      }
    },
    schedule: (tasks, isoDate) => {
      if (tasks.length > 0 && graph?.generation !== undefined && !scheduleMutation.isPending) {
        scheduleMutation.mutate({ tasks, isoDate, generation: graph.generation })
      }
    },
    convertToBullet: (tasks) => {
      if (tasks.length > 0 && graph?.generation !== undefined && !convertMutation.isPending) {
        convertMutation.mutate({ tasks: tasks, generation: graph.generation })
      }
    },
    editAndConvertToBullet: (task, content) => {
      if (graph?.generation !== undefined && !editAndConvertMutation.isPending) {
        editAndConvertMutation.mutate({ task, content, generation: graph.generation })
      }
    },
    archive: () => archiveRecentlyCompleted(root),
  }
}
