import type { AiPrompt, AiPromptSurface } from '../settings/schema.ts'

/**
 * The editor AI menu's prompt library: the user's saved prompts followed by a
 * curated built-in set (the most-used transformations from old Reflect, with
 * their battle-tested prompt bodies). A prompt body references the selection
 * with the `{{selectedText}}` placeholder — old Reflect's syntax, so saved v1
 * prompts port over verbatim.
 */

/** The `{{selectedText}}` placeholder, matched with flexible inner spacing. */
const SELECTED_TEXT_PLACEHOLDER = /\{\{\s*selectedText\s*\}\}/g

/**
 * Shared guardrails appended to the built-in bodies (old Reflect's "filler"):
 * the result is inserted into the note verbatim, so anything beyond the
 * requested text corrupts it.
 */
const FILLER =
  'Do not wrap the response in quotes. Do not translate the text. Preserve the original Markdown formatting, including [[wikilinks]] and #tags.'

/**
 * The curated built-in prompts, shown after the user's saved prompts (old
 * Reflect listed custom templates first). Transformations of the selection
 * use `replace`; prompts that produce new text (a summary, action items, a
 * continuation) use `append` so accepting never destroys the source — and
 * either way the preview offers the alternate placement at accept time.
 */
export const BUILT_IN_AI_PROMPTS: readonly AiPrompt[] = [
  {
    id: 'built-in:fix-grammar',
    label: 'Fix spelling and grammar',
    body: `Correct the text in triple quotes below into standard English and fix the grammar. Make your best effort; change nothing that is already correct.

"""
{{selectedText}}
"""

Do not return anything other than the corrected text. ${FILLER}`,
    mode: 'replace',
    surface: 'selection',
  },
  {
    id: 'built-in:copy-editor',
    label: 'Act as a copy editor',
    body: `Act as a copy editor. Go through the text in triple quotes below. Edit it for spelling mistakes, grammar issues, punctuation, and generally for readability and flow. Format the text into appropriately sized paragraphs. Make your best effort.

"""
{{selectedText}}
"""

Return only the edited text. If in doubt, or you can't make edits, just return the original text. ${FILLER}`,
    mode: 'replace',
    surface: 'selection',
  },
  {
    id: 'built-in:rephrase',
    label: 'Rephrase my writing',
    body: `Rewrite the text in triple quotes below in your own words. Rephrase the text, keeping the meaning.

"""
{{selectedText}}
"""

Do not return anything other than the rephrased text. ${FILLER}`,
    mode: 'replace',
    surface: 'selection',
  },
  {
    id: 'built-in:simplify',
    label: 'Simplify and condense my writing',
    body: `The following text in triple quotes below has already been written:

"""
{{selectedText}}
"""

Simplify and condense the writing. Do not return anything other than the simplified writing. ${FILLER}`,
    mode: 'replace',
    surface: 'selection',
  },
  {
    id: 'built-in:format-paragraphs',
    label: 'Format paragraphs',
    body: `Format the text in triple quotes below into paragraphs.

"""
{{selectedText}}
"""

Do not return anything other than the formatted text. ${FILLER}`,
    mode: 'replace',
    surface: 'selection',
  },
  {
    id: 'built-in:short-summary',
    label: 'Write a short summary',
    body: `Summarize the text in triple quotes below but keep it concise. Summarize using plain and simple language and keep the same tense.

"""
{{selectedText}}
"""

Do not return anything other than the summary. ${FILLER}`,
    mode: 'append',
    surface: 'selection',
  },
  {
    id: 'built-in:takeaways',
    label: 'List key takeaways',
    body: `My notes are below in triple quotes:

"""
{{selectedText}}
"""

Write a Markdown list (using dashes) of key takeaways from my notes. Write at least 3 items. Do not return anything other than the list. ${FILLER}`,
    mode: 'append',
    surface: 'selection',
  },
  {
    id: 'built-in:action-items',
    label: 'List action items',
    body: `My note is below in triple quotes:

"""
{{selectedText}}
"""

Write a todo list of action items from my note using the following format:

- [ ] <first action item>
- [ ] <second action item>

Only include actions actually implied by the note. Do not return anything other than the todo list. ${FILLER}`,
    mode: 'append',
    surface: 'selection',
  },
  {
    id: 'built-in:points-to-document',
    label: 'Points to document',
    body: `Turn the points in triple quotes below into a quick document on the subject. Try to be as pithy and straightforward as possible. Bold key arguments. Use Markdown to cleanly format the output.

"""
{{selectedText}}
"""

Do not return anything other than the document. ${FILLER}`,
    mode: 'replace',
    surface: 'selection',
  },
  {
    id: 'built-in:continuation',
    label: 'Write the next paragraph',
    body: `The following text in triple quotes below has already been written:

"""
{{selectedText}}
"""

Write the next paragraph, keeping the same voice and style. Stay on the same topic. Write at least 3 sentences. Do not repeat the existing text. ${FILLER}`,
    mode: 'append',
    surface: 'selection',
  },
  {
    id: 'built-in:backlinks',
    label: 'Decorate my writing with backlinks',
    body: `Decorate the text in triple quotes below with backlinks. Keep the original text, but surround each person name, company name, place, and project with double square brackets — so a person named Jerry becomes [[Jerry]]. If it starts with a capital letter, backlink it. Do not include actions or verbs.

"""
{{selectedText}}
"""

Do not return anything other than the decorated text. ${FILLER}`,
    mode: 'replace',
    surface: 'selection',
  },
]

/**
 * Render a prompt body against the selection: every `{{selectedText}}`
 * occurrence is substituted, and a body without the placeholder gets the
 * selection appended as fenced context (old Reflect's compile rule), so a
 * bare instruction like "Translate to French" still works.
 */
export function renderSelectionPrompt(body: string, selectedText: string): string {
  if (SELECTED_TEXT_PLACEHOLDER.test(body)) {
    SELECTED_TEXT_PLACEHOLDER.lastIndex = 0
    return substitute(body, { selectedText })
  }
  return `${body}

Use the following text in triple quotes as context for your response:
"""
${selectedText}
"""`
}

/**
 * The values a `slash` prompt can ask for by name (Plan 26). Gathered by the
 * caller, because core does not reach for a graph or a calendar on its own.
 */
export interface PromptValues {
  /** Today, written the way a person would say it. */
  today: string
  /** The day's calendar events, or a line saying there are none. */
  events: string
  /** Open tasks a cloud model may see, or a line saying there are none. */
  tasks: string
}

/**
 * One placeholder a prompt body can use, and what it resolves to.
 *
 * This is the only description of the vocabulary: the settings form renders
 * it, so a placeholder that gains a meaning here gains it in the UI too. A
 * resolver added without an entry is caught by the drift test beside this
 * file — documentation nobody updates is worse than none, because it is
 * believed.
 */
export interface PromptPlaceholder {
  /** What the user types, without the braces. */
  name: keyof PromptValues | 'selectedText'
  /** Which surface offers it. */
  surface: AiPromptSurface
  /** What it resolves to, said the way the user would say it. */
  description: string
}

export const PROMPT_PLACEHOLDERS: readonly PromptPlaceholder[] = [
  {
    name: 'selectedText',
    surface: 'selection',
    description: 'The text you selected.',
  },
  {
    name: 'today',
    surface: 'slash',
    description: 'Today’s date, written out — “Tuesday, 6 October 2026”.',
  },
  {
    name: 'events',
    surface: 'slash',
    description:
      'Today’s events from the calendars you chose, with their times and who is in them. Says so when calendar access is not granted.',
  },
  {
    name: 'tasks',
    surface: 'slash',
    description:
      'Your open tasks, grouped into overdue, due today, and undated. Tasks dated later are left out, and private notes’ tasks are never included.',
  },
]

/** The placeholders a prompt on this surface can use. */
export function placeholdersFor(surface: AiPromptSurface): PromptPlaceholder[] {
  return PROMPT_PLACEHOLDERS.filter((placeholder) => placeholder.surface === surface)
}

/**
 * Render a prompt that runs on no selection.
 *
 * Nothing is appended to a body with no placeholder: on this surface there is
 * no selection to append, so a bare instruction is simply the whole prompt.
 * `{{selectedText}}` resolves to empty rather than erroring — a user moving a
 * prompt between surfaces should get a worse answer, not a crash.
 */
export function renderNotePrompt(body: string, values: PromptValues): string {
  return substitute(body, { ...values, selectedText: '' })
}

/**
 * Substitute `{{name}}` placeholders, matched with flexible inner spacing.
 *
 * A replacer function, not the string form: `$&` and `$$` sequences in a
 * value must land verbatim, not as replacement patterns. Values are
 * substituted against the original body in one pass, so a value that itself
 * contains `{{tasks}}` is left alone rather than expanded again.
 */
function substitute(body: string, values: Record<string, string>): string {
  return body.replaceAll(/\{\{\s*(\w+)\s*\}\}/gu, (match, name: string) =>
    name in values ? (values[name] ?? '') : match,
  )
}

/**
 * The prompts the AI menu lists for a filter query: the user's saved prompts
 * first (old Reflect's order — the user's own workflow beats the stock set),
 * then the built-ins, case-insensitively filtered on the label. An empty
 * query returns everything. The menu does not re-rank — order here is display
 * order.
 *
 * Only `selection` prompts: a prompt written for the `/` menu expects the
 * day's events, not the paragraph the user just highlighted.
 */
export function filterAiPrompts(prompts: readonly AiPrompt[], query: string): AiPrompt[] {
  const all = [...prompts.filter(runsOnSelection), ...BUILT_IN_AI_PROMPTS]
  return byLabel(all, query)
}

/** The user's `/` menu prompts for a query. There are no built-ins here yet. */
export function filterSlashPrompts(prompts: readonly AiPrompt[], query: string): AiPrompt[] {
  return byLabel(
    prompts.filter((prompt) => !runsOnSelection(prompt)),
    query,
  )
}

function runsOnSelection(prompt: AiPrompt): boolean {
  return prompt.surface !== 'slash'
}

function byLabel(prompts: readonly AiPrompt[], query: string): AiPrompt[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...prompts]
  return prompts.filter((prompt) => prompt.label.toLowerCase().includes(needle))
}
