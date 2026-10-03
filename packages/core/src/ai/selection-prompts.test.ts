import { describe, expect, it } from 'vitest'
import type { AiPrompt } from '../settings/schema.ts'
import type { PromptValues } from './selection-prompts.ts'
import {
  BUILT_IN_AI_PROMPTS,
  filterAiPrompts,
  filterSlashPrompts,
  placeholdersFor,
  PROMPT_PLACEHOLDERS,
  renderNotePrompt,
  renderSelectionPrompt,
} from './selection-prompts.ts'

describe('renderSelectionPrompt', () => {
  it('substitutes the {{selectedText}} placeholder', () => {
    expect(renderSelectionPrompt('Fix this:\n\n{{selectedText}}', 'teh text')).toBe(
      'Fix this:\n\nteh text',
    )
  })

  it('substitutes every occurrence and tolerates inner spacing', () => {
    expect(renderSelectionPrompt('{{selectedText}} and {{ selectedText }}', 'x')).toBe('x and x')
  })

  it('appends the selection as fenced context when the body has no placeholder', () => {
    expect(renderSelectionPrompt('Translate to French', 'hello')).toBe(
      'Translate to French\n\nUse the following text in triple quotes as context for your response:\n"""\nhello\n"""',
    )
  })

  it('keeps dollar sequences in the selection verbatim', () => {
    expect(renderSelectionPrompt('Fix: {{selectedText}}', 'costs $$40 and $& more')).toBe(
      'Fix: costs $$40 and $& more',
    )
  })

  it('is stateful-regex safe: consecutive calls behave identically', () => {
    const body = 'Fix: {{selectedText}}'
    expect(renderSelectionPrompt(body, 'a')).toBe('Fix: a')
    expect(renderSelectionPrompt(body, 'b')).toBe('Fix: b')
  })
})

describe('filterAiPrompts', () => {
  const saved: AiPrompt[] = [
    {
      id: 'saved-1',
      label: 'Translate to French',
      body: '{{selectedText}}',
      mode: 'replace',
      surface: 'selection',
    },
  ]

  it('lists saved prompts first, then built-ins, for an empty query (v1 order)', () => {
    const prompts = filterAiPrompts(saved, '')
    expect(prompts[0]?.id).toBe('saved-1')
    expect(prompts.slice(1)).toEqual(BUILT_IN_AI_PROMPTS)
  })

  it('filters case-insensitively on the label', () => {
    const prompts = filterAiPrompts(saved, 'french')
    expect(prompts.map((prompt) => prompt.id)).toEqual(['saved-1'])
    expect(filterAiPrompts(saved, 'GRAMMAR').map((prompt) => prompt.id)).toEqual([
      'built-in:fix-grammar',
    ])
  })

  it('every built-in prompt references the selection via the placeholder', () => {
    for (const prompt of BUILT_IN_AI_PROMPTS) {
      expect(prompt.body).toContain('{{selectedText}}')
    }
  })
})

describe('renderNotePrompt', () => {
  const values = { today: 'Tuesday, 6 October 2026', events: '- 09:30 Standup', tasks: '- algo' }

  it('substitutes every context placeholder', () => {
    const rendered = renderNotePrompt(
      'Hoy es {{today}}.\n\nAgenda:\n{{events}}\n\nPendiente:\n{{tasks}}',
      values,
    )

    expect(rendered).toBe(
      'Hoy es Tuesday, 6 October 2026.\n\nAgenda:\n- 09:30 Standup\n\nPendiente:\n- algo',
    )
  })

  it('appends nothing to a bare instruction — there is no selection to append', () => {
    expect(renderNotePrompt('Resume mi día.', values)).toBe('Resume mi día.')
  })

  it('leaves a value containing a placeholder alone, rather than expanding it twice', () => {
    const rendered = renderNotePrompt('{{tasks}}', { ...values, tasks: '- escribir {{today}}' })

    expect(rendered).toBe('- escribir {{today}}')
  })

  it('keeps $ sequences verbatim, not as replacement patterns', () => {
    expect(renderNotePrompt('{{tasks}}', { ...values, tasks: '- cobrar $& y $$' })).toBe(
      '- cobrar $& y $$',
    )
  })

  it('resolves a selection placeholder to empty rather than erroring', () => {
    // The user moved a prompt between surfaces. A worse answer, not a crash.
    expect(renderNotePrompt('Traduce: {{selectedText}}', values)).toBe('Traduce: ')
  })

  it('leaves an unknown placeholder untouched, so a typo is visible', () => {
    expect(renderNotePrompt('{{taks}}', values)).toBe('{{taks}}')
  })
})

describe('surfaces', () => {
  const onSelection: AiPrompt = {
    id: 'sel',
    label: 'Shorten',
    body: '{{selectedText}}',
    mode: 'replace',
    surface: 'selection',
  }
  const onSlash: AiPrompt = {
    id: 'slash',
    label: 'daily',
    body: '{{events}}',
    mode: 'append',
    surface: 'slash',
  }

  it('keeps each prompt out of the other menu', () => {
    expect(filterAiPrompts([onSelection, onSlash], '').map((p) => p.id)).toContain('sel')
    expect(filterAiPrompts([onSelection, onSlash], '').map((p) => p.id)).not.toContain('slash')
    expect(filterSlashPrompts([onSelection, onSlash], '')).toEqual([onSlash])
  })

  it('offers no built-ins on the slash surface — they all expect a selection', () => {
    expect(filterSlashPrompts([], '')).toEqual([])
  })

  it('filters the slash menu by label, case-insensitively', () => {
    expect(filterSlashPrompts([onSlash], 'DAI')).toEqual([onSlash])
    expect(filterSlashPrompts([onSlash], 'weekly')).toEqual([])
  })
})

describe('the placeholder catalogue', () => {
  const values: PromptValues = { today: 'T', events: 'E', tasks: 'K' }

  it('documents every value a slash prompt resolves — and nothing it does not', () => {
    // Both directions on purpose. A resolver with no entry is invisible to
    // the user; an entry with no resolver renders as literal braces in their
    // note, which reads as the feature being broken.
    const documented = placeholdersFor('slash')
      .map((placeholder) => placeholder.name)
      .sort()
    expect(documented).toEqual(Object.keys(values).sort())
  })

  it('substitutes every placeholder it advertises', () => {
    const body = placeholdersFor('slash')
      .map((placeholder) => `{{${placeholder.name}}}`)
      .join(' ')

    expect(renderNotePrompt(body, values)).toBe('T E K')
  })

  it('keeps the selection placeholder off the slash surface, and the reverse', () => {
    expect(placeholdersFor('selection').map((entry) => entry.name)).toEqual(['selectedText'])
    expect(placeholdersFor('slash').map((entry) => entry.name)).not.toContain('selectedText')
  })

  it('says what each one brings, not just what it is called', () => {
    for (const placeholder of PROMPT_PLACEHOLDERS) {
      expect(placeholder.description.length).toBeGreaterThan(20)
    }
  })
})
