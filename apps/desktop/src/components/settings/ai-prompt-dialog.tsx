import { lazy, Suspense, type ReactElement } from 'react'
import type { AiPrompt } from '@reflect/core'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import type { AiPromptDraft } from '@/hooks/use-ai-prompts.ts'

interface AiPromptDialogProps {
  /** The prompt being edited, or null when adding a new one. */
  prompt: AiPrompt | null
  /** Persists the draft (add or update). */
  onSave: (draft: AiPromptDraft) => void
  onClose: () => void
}

const AiPromptForm = lazy(async () => {
  const { AiPromptForm } = await import('@/components/settings/ai-prompt-form.tsx')
  return { default: AiPromptForm }
})

/**
 * The add/edit dialog for a saved AI prompt: a label for the picker, the
 * prompt body (referencing its surface's placeholders — `{{selectedText}}` is old
 * Reflect's syntax), and whether the accepted result replaces the selection
 * or is inserted below it.
 */
export function AiPromptDialog({ prompt, onSave, onClose }: AiPromptDialogProps): ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <Suspense>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{prompt === null ? 'Add prompt' : 'Edit prompt'}</DialogTitle>
            <DialogDescription>
              Where it runs decides what it can see. The placeholders for the surface you pick are
              listed under the prompt.
            </DialogDescription>
          </DialogHeader>

          <AiPromptForm prompt={prompt} onSave={onSave} onClose={onClose} />
        </DialogContent>
      </Suspense>
    </Dialog>
  )
}
