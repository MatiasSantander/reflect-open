import type { ReactElement } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import type { AiPrompt, AiPromptMode, AiPromptSurface } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import type { AiPromptDraft } from '@/hooks/use-ai-prompts.ts'

interface AiPromptFormProps {
  /** The prompt being edited, or null when adding a new one. */
  prompt: AiPrompt | null
  /** Persists the draft (add or update). */
  onSave: (draft: AiPromptDraft) => void
  onClose: () => void
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

export function AiPromptForm({ prompt, onSave, onClose }: AiPromptFormProps): ReactElement {
  const { register, control, handleSubmit, setValue, formState } = useForm<AiPromptDraft>({
    defaultValues: {
      label: prompt?.label ?? '',
      body: prompt?.body ?? '',
      mode: prompt?.mode ?? 'replace',
      surface: prompt?.surface ?? 'selection',
    },
  })
  const mode = useWatch({ control, name: 'mode' })
  const surface = useWatch({ control, name: 'surface' })
  const runsOnSelection = surface === 'selection'

  const submit = handleSubmit((values) => {
    onSave({
      label: values.label.trim(),
      body: values.body.trim(),
      mode: values.mode,
      surface: values.surface,
    })
    onClose()
  })

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event)
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL_CLASS}>Runs on</span>
        <Select
          value={surface}
          items={{
            selection: 'Text I select',
            slash: 'The / menu, with no selection',
          }}
          onValueChange={(value) => setValue('surface', value as AiPromptSurface)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="selection">Text I select</SelectItem>
              <SelectItem value="slash">The / menu, with no selection</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL_CLASS}>Label</span>
        <Input
          {...register('label', { required: true })}
          aria-invalid={formState.errors.label !== undefined || undefined}
          placeholder="Translate to French"
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL_CLASS}>Prompt</span>
        <Textarea
          {...register('body', { required: true })}
          aria-invalid={formState.errors.body !== undefined || undefined}
          className="field-sizing-fixed h-40 max-h-[50dvh] resize-y overflow-y-auto"
          rows={5}
          placeholder={
            runsOnSelection
              ? 'Translate the following text to French.\n\n{{selectedText}}'
              : 'Summarise my day.\n\nToday is {{today}}.\n\nEvents:\n{{events}}\n\nOpen tasks:\n{{tasks}}'
          }
        />
        <span className="text-xs text-text-tertiary">
          {runsOnSelection
            ? 'Use {{selectedText}} where the selection should appear.'
            : 'Available: {{today}}, {{events}}, {{tasks}}. The result is inserted at the cursor.'}
        </span>
      </label>
      <label className={`flex-col gap-1.5 ${runsOnSelection ? 'flex' : 'hidden'}`}>
        <span className={FIELD_LABEL_CLASS}>Result</span>
        <Select
          value={mode}
          items={{ replace: 'Replaces the selection', append: 'Inserted below the selection' }}
          onValueChange={(value) => setValue('mode', value as AiPromptMode)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="replace">Replaces the selection</SelectItem>
              <SelectItem value="append">Inserted below the selection</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">{prompt === null ? 'Add prompt' : 'Save'}</Button>
      </div>
    </form>
  )
}
