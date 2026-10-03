import { renderHook } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiPrompt } from '@reflect/core'
import type { NoteEditorHandle } from './note-editor.tsx'

const daily: AiPrompt = {
  id: 'p-daily',
  label: 'daily',
  body: 'Resume mi día.\n\n{{events}}\n\n{{tasks}}',
  mode: 'append',
  surface: 'slash',
}
const shorten: AiPrompt = {
  id: 'p-shorten',
  label: 'Shorten',
  body: '{{selectedText}}',
  mode: 'replace',
  surface: 'selection',
}

const prompts = vi.hoisted(() => ({ current: [] as AiPrompt[] }))
const providers = vi.hoisted(() => ({ current: [{ id: 'a', provider: 'anthropic' }] as unknown[] }))
const note = vi.hoisted(() => ({ current: { isPrivate: false } as { isPrivate: boolean } | null }))
const aiApiKeyForConfig = vi.hoisted(() => vi.fn(async () => 'sk-test'))
const promptContext = vi.hoisted(() =>
  vi.fn(async () => ({ today: 'Tuesday', events: '- 09:30 Standup', tasks: '- algo' })),
)
const transformSelection = vi.hoisted(() =>
  vi.fn(async function* (_options: { selection: string }) {
    yield { type: 'complete' as const, text: '## Hoy\n\n- Standup a las 09:30' }
  }),
)

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  aiApiKeyForConfig,
  promptContext,
  transformSelection,
}))
vi.mock('@/hooks/use-ai-prompts.ts', () => ({ useAiPrompts: () => ({ prompts: prompts.current }) }))
vi.mock('@/hooks/use-ai-providers.ts', () => ({
  useAiProviders: () => ({
    providers: providers.current,
    defaultProvider: providers.current[0] ?? null,
  }),
}))
vi.mock('@/hooks/use-note-row.ts', () => ({ useNoteRow: () => note.current }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { calendarIds: ['work'] } }),
}))
vi.mock('@/lib/provider-fetch.ts', () => ({ providerFetch: vi.fn() }))

const { useAiSlashItems } = await import('./use-ai-slash-items.ts')

function fakeEditor(): NoteEditorHandle & { inserted: string[] } {
  const inserted: string[] = []
  return {
    inserted,
    getMarkdown: () => '',
    setMarkdown: () => {},
    insertMarkdown: (markdown) => {
      inserted.push(markdown)
    },
    focus: () => {},
    setSelection: () => {},
    getSelectedText: () => '',
    openSelectionMenu: () => {},
    startPendingReplacement: () => false,
    appendPendingReplacementText: () => {},
    acceptPendingReplacement: () => {},
    discardPendingReplacement: () => {},
    findNext: () => {},
    findPrevious: () => {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  prompts.current = [daily, shorten]
  providers.current = [{ id: 'a', provider: 'anthropic' }]
  note.current = { isPrivate: false }
})

describe('useAiSlashItems', () => {
  it('offers only the prompts written for the slash menu', async () => {
    const { result } = await renderHook(() => useAiSlashItems('notes/a.md', () => null))

    expect(result.current('').map((item) => item.id)).toEqual(['p-daily'])
  })

  it('filters by what the user typed', async () => {
    const { result } = await renderHook(() => useAiSlashItems('notes/a.md', () => null))

    expect(result.current('dai')).toHaveLength(1)
    expect(result.current('weekly')).toHaveLength(0)
  })

  it('offers nothing with no provider configured, rather than a row that fails', async () => {
    providers.current = []
    const { result } = await renderHook(() => useAiSlashItems('notes/a.md', () => null))

    expect(result.current('')).toEqual([])
  })

  it('offers nothing in a private note', async () => {
    note.current = { isPrivate: true }
    const { result } = await renderHook(() => useAiSlashItems('notes/a.md', () => null))

    expect(result.current('')).toEqual([])
  })

  it('renders the gathered context into the prompt and inserts what comes back', async () => {
    const editor = fakeEditor()
    const { result } = await renderHook(() => useAiSlashItems('notes/a.md', () => editor))

    result.current('')[0]?.onSelect?.()
    await vi.waitFor(() => expect(editor.inserted).toHaveLength(1))

    expect(editor.inserted[0]).toBe('## Hoy\n\n- Standup a las 09:30')
    const sent = transformSelection.mock.calls[0]?.[0]
    expect(String(sent?.selection)).toContain('- 09:30 Standup')
    expect(String(sent?.selection)).toContain('- algo')
  })

  it('inserts nowhere when the pane is gone by the time the answer lands', async () => {
    // A prompt takes seconds; the user can switch notes.
    const { result } = await renderHook(() => useAiSlashItems('notes/a.md', () => null))

    result.current('')[0]?.onSelect?.()
    await vi.waitFor(() => expect(transformSelection).toHaveBeenCalled())
  })

  it('writes nothing when the model comes back empty', async () => {
    transformSelection.mockImplementationOnce(async function* (_options: { selection: string }) {
      yield { type: 'complete' as const, text: '   ' }
    })
    const editor = fakeEditor()
    const { result } = await renderHook(() => useAiSlashItems('notes/a.md', () => editor))

    result.current('')[0]?.onSelect?.()
    await vi.waitFor(() => expect(transformSelection).toHaveBeenCalled())

    expect(editor.inserted).toEqual([])
  })
})
