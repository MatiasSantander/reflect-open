import type { ReactElement } from 'react'
import { NoteActionsSection } from './note-actions-section.tsx'
import { PublishedUrlSection } from './published-url-section.tsx'
import { SimilarNotesSection } from './similar-notes-section.tsx'
import { TasksSection } from './tasks-section.tsx'

interface NoteContextSidebarProps {
  /** Graph-relative path of the open note the sidebar describes. */
  path: string
}

/**
 * An ordinary note's contextual sidebar: note actions, the open tasks across
 * the graph, then the note's semantic neighbors — the only place similar
 * notes appear. Inbound links live under the note itself (the
 * incoming-backlinks panel), not here.
 *
 * The task list is the same one the daily sidebar shows, deliberately: what
 * is still owed does not stop being true because the note you are reading is
 * not a day. Rendered in the AppShell's right region on `note` routes.
 */
export function NoteContextSidebar({ path }: NoteContextSidebarProps): ReactElement {
  return (
    <div className="flex flex-col py-2 text-text">
      <div className="my-4 space-y-4 pb-4">
        <NoteActionsSection path={path} showTrash />
        <PublishedUrlSection path={path} />
        <TasksSection />
        <SimilarNotesSection path={path} />
      </div>
    </div>
  )
}
