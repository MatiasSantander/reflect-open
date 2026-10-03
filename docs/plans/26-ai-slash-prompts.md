# 26 — AI prompts in the `/` menu

## What

A saved AI prompt can run from the editor's `/` menu instead of on a
selection, with the day's events and open tasks available to it as
placeholders. Typing `/daily` writes today's summary into the note.

## Why it is not a new feature

Everything needed already exists and is pointed at the wrong surface:

- **The prompt library** (`settings.aiPrompts`) already stores a label, a
  body and where the result lands. It only lacks *where it runs*.
- **The provider call** (`transformSelection`) is already "render a prompt,
  stream the result" with no history and no tools. An empty selection makes
  it a plain generation.
- **The `/` menu already takes rows from the host** — note templates are
  injected exactly this way (`use-template-slash-items.ts`).

So this is one field, two placeholder resolvers and a second row source.

## Contracts

**A prompt declares its surface.** `surface: 'selection' | 'slash'`, defaulting
to `selection` so every saved prompt and every built-in keeps working
untouched. The AI menu lists `selection` prompts; the `/` menu lists `slash`
ones. A prompt is in exactly one place — a prompt written for a selection
reads as nonsense with none, and the reverse.

**New placeholders, same rendering rule.** `{{today}}`, `{{events}}` and
`{{tasks}}` join `{{selectedText}}`. A body with no placeholder at all still
runs: the old rule (append the context fenced) is kept for the selection
surface, and for a slash prompt a body with no placeholder is simply the whole
prompt — nothing is appended, because there is no selection to append.

**The result is inserted, not previewed.** Same as a template: the stream
completes, the markdown lands at the cursor. The selection surface keeps its
accept/discard preview, which exists because it *overwrites* text; a slash
prompt only ever adds.

**Privacy is gated twice.** The note being written into must not be
`private: true` — the existing rule, unchanged. And the gathered context
excludes tasks from private notes: `getOpenTasks` includes them deliberately
("this is a local-only surface"), and a prompt to a cloud provider is not
one. A separate query makes that explicit rather than filtering at the call
site, where the next caller would forget.

## Traps

**T1 — The private-task leak.** The whole point of `CloudSafe` is that a
private note's content cannot typecheck its way into a provider call. Gathered
context is a new door into the same room: `{{tasks}}` reads every note in the
graph. Mint it through the same gate.

**T2 — A slash prompt with no provider configured.** The `/` menu must not
offer a row that fails on select. No provider → no AI rows, same as the AI
menu's behaviour.

**T3 — A late result inserting into the wrong note.** A prompt takes seconds;
the user can switch notes. The editor handle is read at insert time, not at
select time — the pattern `use-template-slash-items.ts` already documents.

**T4 — An empty day.** No events and no tasks is the common case at 9am. The
placeholders resolve to an explicit "nothing", never an empty string, so the
model is not left guessing whether the data failed to load.

## Edge cases

- **E1** — Calendar permission not granted: `{{events}}` resolves to a line
  saying so, rather than an empty list that reads as "no meetings today".
- **E2** — A prompt whose label collides with a template's: both rows show.
  The `/` menu is a search, not a registry.
- **E3** — A body using `{{selectedText}}` on the slash surface: resolves to
  empty. Not an error — the user moved a prompt between surfaces.
- **E4** — The graph has no index yet: tasks resolve to the "nothing" line.

## Shape

1. `surface` on `aiPromptSchema`, defaulted.
2. `renderPrompt(body, values)` generalising the existing substitution;
   `renderSelectionPrompt` keeps its signature and delegates.
3. `promptContext()` in core — gathers today, events, tasks as markdown.
4. `getCloudSafeOpenTasks()` beside `getOpenTasks`.
5. `useAiSlashItems` beside `useTemplateSlashItems`; `note-pane` merges them.
6. The settings form grows a "Runs on" select and names the placeholders.
