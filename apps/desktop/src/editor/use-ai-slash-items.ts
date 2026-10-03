import { useCallback } from 'react'
import type { SlashMenuItem } from '@meowdown/react'
import {
  aiApiKeyForConfig,
  cloudSafeSelection,
  filterSlashPrompts,
  isPrivateNoteError,
  promptContext,
  renderNotePrompt,
  transformSelection,
  type AiPrompt,
} from '@reflect/core'
import { toast } from '@/components/ui/toast.tsx'
import { useAiPrompts } from '@/hooks/use-ai-prompts.ts'
import { useAiProviders } from '@/hooks/use-ai-providers.ts'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { providerFetch } from '@/lib/provider-fetch.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import type { NoteEditorHandle } from './note-editor.tsx'

/**
 * The editor's `/` menu rows for AI prompts (Plan 26): the user's saved
 * prompts whose surface is `slash`, beside the template rows and meowdown's
 * built-in blocks.
 *
 * The result is inserted when the stream finishes, exactly like a template —
 * which is what these are. The AI menu's accept/discard preview exists
 * because that flow *overwrites* the text you selected; a slash prompt only
 * ever adds, so there is nothing to undo but an undo.
 *
 * `getEditor` is read at insert time, not at select time: a prompt takes
 * seconds, and a late result after the user moved on must land nowhere rather
 * than in whatever note is open now.
 */
export function useAiSlashItems(
  path: string,
  getEditor: () => NoteEditorHandle | null,
): (query: string) => SlashMenuItem[] {
  const { prompts } = useAiPrompts()
  const { providers, defaultProvider } = useAiProviders()
  const { settings } = useSettings()
  const note = useNoteRow(path)

  const run = useCallback(
    async (prompt: AiPrompt): Promise<void> => {
      const config = defaultProvider
      if (config === null) {
        return
      }
      const apiKey = await aiApiKeyForConfig(config)
      if (apiKey === null) {
        toast.add({
          type: 'error',
          title: `${prompt.label} needs an API key for ${config.provider}.`,
        })
        return
      }
      // The same gate as the selection surface, on the same subject: the note
      // being written into. A private note does not send its contents, and it
      // does not commission text either.
      const body = cloudSafeSelection(
        { path, isPrivate: note?.isPrivate ?? false },
        renderNotePrompt(
          prompt.body,
          await promptContext({ now: new Date(), calendarIds: settings.calendarIds }),
        ),
      )
      let text = ''
      for await (const event of transformSelection({
        config,
        apiKey,
        fetchFn: providerFetch,
        // The whole prompt is already rendered; `transformSelection` appends
        // nothing when the body carries no `{{selectedText}}` of its own.
        promptBody: '{{selectedText}}',
        selection: body,
      })) {
        if (event.type === 'complete') {
          text = event.text
        }
        if (event.type === 'error') {
          toast.add({ type: 'error', title: `${prompt.label} failed: ${event.message}` })
          return
        }
      }
      const trimmed = text.trim()
      if (trimmed === '') {
        toast.add({ type: 'error', title: `${prompt.label} came back empty.` })
        return
      }
      getEditor()?.insertMarkdown(trimmed)
    },
    [defaultProvider, path, note?.isPrivate, settings.calendarIds, getEditor],
  )

  return useCallback(
    (query: string): SlashMenuItem[] => {
      // A row that cannot work is worse than no row: offering `/daily` with no
      // provider configured teaches the user the feature is broken.
      if (providers.length === 0 || (note?.isPrivate ?? false)) {
        return []
      }
      return filterSlashPrompts(prompts, query).map((prompt) => ({
        id: prompt.id,
        label: prompt.label,
        keywords: ['ai'],
        onSelect: () => {
          void run(prompt).catch((cause: unknown) => {
            toast.add({
              type: 'error',
              title: isPrivateNoteError(cause)
                ? 'This note is private and cannot be sent to an AI provider.'
                : `${prompt.label} failed.`,
            })
          })
        },
      }))
    },
    [prompts, providers.length, note?.isPrivate, run],
  )
}
