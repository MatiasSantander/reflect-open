import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, SlidersHorizontal } from 'lucide-react'
import { displayNoteTitle } from '@reflect/core'
import { formatDayLabel } from '@/lib/dates.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed.ts'
import { useTaskFilters } from '@/lib/tasks/task-filters.ts'
import { taskKey } from '@/lib/tasks/task-identity.ts'
import { composeVisibleTaskGroups } from '@/lib/tasks/task-visibility.ts'
import {
  createCompletedTasksQueryOptions,
  createOpenTasksQueryOptions,
} from '@/lib/tasks/tasks-query.ts'
import { useTaskActions } from '@/lib/tasks/use-task-actions.ts'
import { useToday } from '@/lib/use-today.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { routeForPath } from '@/routing/route.ts'
import { TaskFiltersMenu } from '@/components/tasks/task-filters-menu.tsx'
import { isModEvent } from '@meowdown/core'
import { SidebarSection } from './sidebar-section.tsx'

/**
 * Open tasks in the context sidebar, beside the day they belong to.
 *
 * Everything that decides *what* shows is shared with the Tasks view, not
 * reimplemented: the same query, the same grouping, the same filter state
 * (session flags under `reflect.tasks.filter.*`, so a bucket hidden there is
 * hidden here), and the same complete action with its optimistic cache write.
 * Two lists that disagree about what is overdue would be worse than one list.
 *
 * What is *not* shared is the Tasks view's interaction model — multi-select,
 * the inline editor, the keyboard map. Those need a focused scroll container
 * and a toolbar to make sense; a 320px column has neither. Here a row does
 * the two things a sidebar is for: tick it off, or go to where it lives.
 */
export function TasksSection(): ReactElement | null {
  const { graph } = useGraph()
  const today = useToday()
  const { filters, toggle } = useTaskFilters()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const navigateNoteLink = useNoteLinkNavigation()
  const actions = useTaskActions()
  const { settings } = useSettings()

  const open = useQuery(createOpenTasksQueryOptions(graph?.root))
  const recentlyCompleted = useRecentlyCompleted(graph?.root ?? null, open.data)
  const completed = useQuery({
    ...createCompletedTasksQueryOptions(graph?.root),
    enabled: filters.archived,
  })

  const groups = useMemo(
    () =>
      composeVisibleTaskGroups({
        open: open.data,
        completed: completed.data,
        recentlyCompleted,
        filters,
        // The sidebar has no search box: the Tasks view is where you go to
        // look for something. This is where you go to see what is left.
        needle: '',
        today,
      }),
    [open.data, completed.data, recentlyCompleted, filters, today],
  )

  // Nothing to show is not the same as nothing to do: a graph still loading
  // its index would otherwise flash an empty section.
  if (open.data === undefined) {
    return null
  }

  return (
    <SidebarSection storageKey="tasks" title="Tasks">
      <div className="space-y-2">
        <div className="flex justify-end px-1">
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs text-text-muted hover:bg-surface-hover hover:text-text"
          >
            <SlidersHorizontal aria-hidden className="size-3" />
            Task filters
          </button>
          <TaskFiltersMenu
            open={filtersOpen}
            onOpenChange={setFiltersOpen}
            filters={filters}
            toggle={toggle}
          />
        </div>
        {groups.length === 0 ? (
          <p className="px-3 py-1 text-xs text-text-muted">Nothing open.</p>
        ) : (
          groups.map((group) => (
            <div key={`${group.kind}-${group.label}`}>
              <p className="px-3 pt-1 pb-0.5 text-2xs font-medium text-text-muted">{group.label}</p>
              <ul>
                {group.tasks.map((task) => (
                  <li key={taskKey(task)} className="group/task flex items-center gap-1.5 px-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={task.checked}
                      aria-label={task.checked ? `Reopen ${task.text}` : `Complete ${task.text}`}
                      onClick={() => actions.toggle([task])}
                      className="flex size-4 flex-none items-center justify-center rounded-full border border-border-strong text-text-muted hover:border-text-secondary"
                    >
                      {task.checked ? <Check aria-hidden className="size-2.5" /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        navigateNoteLink({
                          target: routeForPath(task.notePath),
                          openInNewWindow: isModEvent(event),
                        })
                      }}
                      className="min-w-0 flex-1 truncate rounded-md px-1 py-1 text-left text-xs leading-5 text-text-secondary hover:bg-surface-hover hover:text-text"
                      title={task.text}
                    >
                      <span className={cn(task.checked && 'line-through opacity-60')}>
                        {task.text}
                      </span>
                    </button>
                    {/* Only under a date bucket, which aggregates tasks from
                        many notes. A `note` group's header already says where
                        they are, and repeating it fills a 320px column with
                        the same word. The Tasks view draws the same line. */}
                    {group.kind === 'note' ? null : (
                      <span className="flex-none text-2xs text-text-muted">
                        {task.dailyDate === null
                          ? displayNoteTitle(task.noteTitle)
                          : formatDayLabel(task.dailyDate, settings.dateFormat)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </SidebarSection>
  )
}
