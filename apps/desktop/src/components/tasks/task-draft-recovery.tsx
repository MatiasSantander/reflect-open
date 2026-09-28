import type { ReactElement } from 'react'
import { useFailedTaskDrafts, dismissTaskDraft } from '@/lib/tasks/task-drafts.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { Button } from '@/components/ui/button.tsx'

/** Failed drafts remain selectable until explicitly dismissed. */
export function TaskDraftRecovery(): ReactElement | null {
  const { graph } = useGraph()
  const drafts = useFailedTaskDrafts().filter((draft) => draft.generation === graph?.generation)
  if (drafts.length === 0) return null
  return (
    <div role="alert" className="space-y-2 border-b border-border p-3 text-sm">
      <p>These edits could not be saved. Copy your draft before refreshing or dismissing it.</p>
      {drafts.map((draft) => (
        <div key={draft.key}>
          <p>{draft.task.notePath}</p>
          <textarea
            aria-label="Unsaved task draft"
            readOnly
            value={draft.content}
            className="w-full select-text rounded border border-border p-2"
          />
          <Button variant="ghost" size="sm" onClick={() => dismissTaskDraft(draft.key)}>
            Dismiss draft
          </Button>
        </div>
      ))}
    </div>
  )
}
