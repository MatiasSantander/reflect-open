# Plan 25 — Google Calendar in the daily note

**Goal:** Today's Google Calendar events materialize inside the daily note as a
managed markdown block — each event is a `[[wiki link]]`, so the event's note
accumulates every occurrence via backlinks (the "series" for free). Markdown
stays the source of truth: the sync block is idempotent, user notes nested
under an event are never touched, and a deleted/cancelled event **never deletes
markdown** — it strikes the line through. Read-only against Google in Phase 1;
creating events from a note is Phase 3.

**Depends on:** Plan 03 (parser / wiki-link extension), Plan 04 (index +
watcher; `calendar_*` projection tables), Plan 06 (daily notes), Plan 07
(backlinks). Follows the Plan 21 pattern for a user-connected external service.

**Status:** draft — lifecycle decision review pending (see *Open decisions*).

## Principles applied

- **BYOK, no Reflect infrastructure.** The user connects their own Google OAuth
  credential (same contract as AI providers). Tokens live in the OS keychain —
  never in markdown, Git, or `.reflect/`.
- **Markdown is the source of truth.** The sync writes a *managed block* into
  the daily note; everything outside it — and everything the user nests under
  an event line — belongs to the user and is never rewritten.
- **SQLite is a rebuildable projection.** `calendar_instances` maps
  `(instance_id → daily, line state, tombstones)`. Wiping the index must not
  lose user intent, so *user-deleted* tombstones are re-derivable from the
  absence of the marker in markdown (see case U2).
- **`private: true` is a hard block** — irrelevant here by design: the
  integration only *reads* from Google; note content is never sent anywhere.
- **Keyboard-native, minimal UI.** One ⌘K command ("Insert / refresh today's
  events"), background refresh, dots on the mini-calendar. No calendar screen.

## Shape of the managed block

```markdown
## Meetings

- 10:00–10:30 [[Check-in Pase Anual]] <!-- gcal:abc123_20261001 -->
  - my prep notes (user-owned, never touched)
- ~~13:00–13:50 [[Preply lesson - Oliver B.]]~~ (cancelled) <!-- gcal:def456_20261001 -->
```

- One line per event **instance**, ordered by start time; all-day events first.
- The HTML comment carries the Google *instance* id (`eventId_date` for
  recurring events) — invisible in render, survives edits, and is the
  idempotency key. A line without a marker is user-authored and never managed.
- The `[[wiki link]]` is the event's identity for the human: recurring events
  share one note, and backlinks give the full history of the series.
- The event note itself is **lazy** (created on first open, like any wiki
  link), fully user-owned once it exists.

## Lifecycle matrix (the contract)

Google-side changes (detected on refresh):

| # | Google change | Daily-note effect | Event-note effect |
|---|---------------|-------------------|-------------------|
| G1 | New event (today/future) | Line inserted into that day's block, in time order. Creates the block (and `## Meetings`) if absent. | None (lazy). |
| G2 | Event deleted | Line is **struck through** + `(cancelled)`. Never removed — user notes may be nested under it. | **Never deleted.** The note and its history are the user's. |
| G3 | Event cancelled / I declined | Same as G2, suffix `(cancelled)` / `(declined)`. | Never touched. |
| G4 | Renamed | Line text updates to the new title. If the event note already exists, rename it through the standard id-stable rename (Plan 17) so backlinks survive; if only the link text exists, just rewrite it. | Renamed via ULID-stable rename; user content intact. |
| G5 | Time changed (same day) | Hours rewritten on the managed line. Nested user notes untouched. | None. |
| G6 | Moved to another day | Old daily: strike through + `(moved to [[YYYY-MM-DD]])`. New daily: fresh line. Nested user notes **stay where they were written** (v1; see D3). | None. |
| G7 | Recurring event | One line per instance per daily, all sharing the same `[[link]]`; idempotency by instance id. | One note accumulates the series via backlinks. |
| G8 | All-day event | Line without hours, pinned at the top of the block. | None. |

User-side changes (detected by the watcher/parser):

| # | User change | Sync behavior |
|---|-------------|---------------|
| U1 | Edits the managed line's text | The line belongs to the sync (it carries the marker): next refresh rewrites it. Personal notes go **nested under** the line, not in it. |
| U2 | Deletes the managed line | Respected. A tombstone (`user_deleted`) is recorded in the projection so refresh does **not** resurrect it. Rebuild-safe: on index rebuild, an instance present in Google but absent from a daily that already has a managed block is treated as user-deleted (not re-inserted). |
| U3 | Deletes the event note | Normal Reflect behavior: the link goes dead. Sync recreates only *lines*, never notes. |
| U4 | Writes above/below the block, or nests notes under a line | Untouched, always. The managed surface is exactly the marked lines. |

Operational cases:

| # | Case | Behavior |
|---|------|----------|
| O1 | Offline / API error | Daily opens instantly with the last-synced block; refresh is async and never blocks rendering. Errors surface once, quietly (status row in Settings). |
| O2 | Duplicate protection | Upsert by instance id within the block; the block is bounded by the `## Meetings` heading + marked lines only. |
| O3 | Timezone / DST | Hours rendered in the device's local zone at refresh time; a zone change rewrites hours on next refresh (they're managed text). |
| O4 | Which calendars | v1: `primary` only. Multi-calendar selection is a later setting. |
| O5 | Refresh cadence | On app focus + every N minutes (default 15) + manual ⌘K command. |

## Phases

- **Phase 1 — read-only daily block.** OAuth connect (keychain), fetch
  today ± 1 day, managed block with G1/G7/G8 + U1–U4, ⌘K refresh command.
- **Phase 2 — full lifecycle.** G2–G6 states (strikethrough, declined, moved),
  tombstones, mini-calendar dots, settings row (account, status, disconnect).
- **Phase 3 — create events from notes.** Select a line like
  `14:00 Dentist` → ⌘K "Create calendar event" → POST to Google, replace the
  line with a managed line. Write scope requested only when the user first
  uses this.

## Open decisions (review before implementing)

- **D1 — OAuth client:** strict BYOK (user pastes their own OAuth client id +
  secret, like AI keys) vs. shipping a public client id with PKCE/device flow.
  Strict BYOK matches the repo's principles; device flow is friendlier.
- **D2 — event-note naming collisions:** `[[Check-in Pase Anual]]` may collide
  with an unrelated user note of the same name. Accept (it's a feature —
  association over hierarchy) or disambiguate with a frontmatter `gcal-series:`
  key on first creation. Proposal: accept, it is the Reflect way.
- **D3 — G6 nested notes:** when an event moves days, should nested user notes
  migrate with it? v1 says no (notes stay in the daily where they were
  written); revisit after real usage.
- **D4 — block heading:** `## Meetings` vs locale-aware vs configurable.
  Proposal: configurable with `## Meetings` default.
