# Plan 25 — Meeting notes (capture, transcribe, summarize)

**Goal:** a meeting becomes one note that writes itself while it happens. The
calendar starts the recording, the transcript lands segment by segment, and a
rolling summary of key points accumulates every few minutes — so when the
meeting ends the note is already there, and anything the user typed during it
sits in the same document.

**Depends on:** the audio-memo pipeline
(`packages/core/src/actions/audio-memo.ts`, `audio-memo-session.ts`) — the
capture-family action that sits alongside Plan 11's link capture — which
supplies segmented sessions, the per-part transcript cache and the retry
posture. The
shipped calendar integration
([docs/porting/calendar-meetings-integration.md](../porting/calendar-meetings-integration.md))
supplies the trigger. Plan 10 supplies the model the summary runs on.

**Status:** draft.

## Where we stand

Most of this plan is already built. Audio memos ship a pipeline that is a
meeting recorder in everything but its trigger and its output shape:

| Already there | Where |
|---|---|
| Segmented sessions: the recorder rotates and each segment lands as a complete file (`<base>.part-NNN.<ext>`, last one `-end`-marked) | `audio-memo-session.ts` (`AUDIO_MEMO_SEGMENT_MS`) |
| Per-part transcript cache under `.reflect/transcripts/` — a pass that dies at part 7 of 12 never re-bills the first six | `audio-memo-session.ts` |
| Transcription with retries, oversize/rejection handling, tombstones | `audio-memo.ts` |
| Note creation, title from a small-model pass, daily-note backlink | `audio-memo.ts` |
| Crash detection for a session that never closed; a live-mic reminder | `audio-memo-session.ts` |
| The day's events, with times, attendees and join links | `packages/core/src/calendar/`, `apps/desktop/src/lib/use-calendar.ts` |

Four things are missing, and only the first is large:

1. **System audio.** Verified absent: no ScreenCaptureKit, no CoreAudio, no
   system-audio path anywhere in the tree. Desktop recording is the webview's
   `MediaRecorder` over `getUserMedia({ audio: true })` — the default input
   device, i.e. the microphone. On a video call that captures one side of the
   conversation.
2. **Live output.** The note is written when the session closes
   (`isSessionReady` requires `isSessionClosed`), not while it runs.
3. **A rolling summary.** Nothing summarizes a transcript in progress.
4. **A trigger.** Recording starts from the sidebar button, never from the
   calendar.

## Scope

**In:** native capture of microphone + system audio on macOS; a calendar or
⌘K trigger; a meeting note whose `## Resumen` and `## Transcript` sections fill
as the meeting runs; reuse of the existing transcription pipeline.

**Out:** diarization and speaker identification; screenshots and OCR;
detecting meetings by sniffing audio processes or window titles (the calendar
plus one keystroke covers it — revisit only if ad-hoc calls turn out to
dominate); iOS; local transcription (worth doing, but orthogonal and
independently useful); any new screen — the recording indicator that exists
today is the whole UI.

## Design contracts

### 1. Rust captures, TypeScript decides

Per [Architecture & Conventions §2](architecture-conventions.md): Rust owns
*capabilities*, TypeScript owns *policy and composition*.

- **Rust** gets a `recording` module beside `calendar.rs`, bound with `objc2`
  exactly as EventKit and Contacts already are (the `Cargo.toml` convention —
  bindings trimmed to the classes the module touches). It opens a
  ScreenCaptureKit stream, writes each segment as a complete audio file using
  the **existing** `audio-memos/<base>.part-NNN.<ext>` naming, and emits
  `recording:segment` when one closes. It knows nothing about meetings, notes
  or summaries.
- **TypeScript** owns everything else: which note, when to transcribe, what to
  summarize, what to write where.

The payoff is that the pipeline the user already exercises daily is reused
rather than forked — only the writer of the segment files changes.

### 2. One mixed track

bitácora records two tracks to separate "you" from "them", because it
diarizes. This plan doesn't, so one mixed track is enough: half the
transcription cost, smaller files, and none of the echo-filtering machinery a
split capture forces (a microphone picking up the speakers produces duplicated
text that has to be filtered by similarity and containment).

On macOS 15+, `SCStream` can capture the microphone alongside system audio in
one stream, which avoids building an audio graph at all — **confirm the API
before committing**; the fallback is mixing the mic into the stream with
`AVAudioEngine` (D1).

### 3. The note exists from the first second

Today's note appears when the session closes. Here it is created when
recording starts, so the user can type in it during the meeting — the point of
the feature. Its title comes from the calendar event when there is one, from
the timestamp otherwise, and stays a normal note: renameable, linkable,
nothing about it stays tied to the recording.

### 4. Two appended sections, everything else untouched

```markdown
# ADIPA <> Aaron Wade

## Resumen
- key points from each closed segment

## Transcript
- the segment's text
```

Both are appended with `appendListItemUnderHeading` — the helper
`addMeetingToDaily` already uses. Appends always land at the **end** of their
section, so text the user types inside one is never displaced, and everything
outside them is never read or rewritten.

### 5. The segment length is the clock

Rotation every 5 minutes: a closed segment is transcribed, appended,
summarized, appended. That *is* the "summary every 5 minutes" behavior — no
second timer, no partial-transcript machinery. The cost is ~12 transcriptions
and ~12 summaries per hour, which is free against a local model and noticeable
against a metered one. The existing 20-minute constant exists for provider
size limits; 5 minutes sits far under all of them.

### 6. The trigger

- **Calendar.** An event with a join link starting within a minute offers a
  cancelable countdown ("Recording 'ADIPA <> Aaron Wade' in 3… [Cancel]") —
  the shape bitácora validated in daily use. Off by default; one setting turns
  it on.
- **⌘K → "Record meeting"** for anything not on the calendar.
- **Stopping** is the user, or the event's end plus a grace period (meetings
  run late), whichever comes first. The existing live-mic reminder covers a
  forgotten recorder.

## Edge cases

| # | Case | Behavior |
|---|------|----------|
| E1 | Screen-recording permission denied | Say so and fall back to microphone-only, visibly. Never silently record half a conversation. |
| E2 | Permission revoked mid-recording | Close the session cleanly, keep every segment already written, surface why. |
| E3 | Meeting runs past the scheduled end | Keep recording to the grace period; the 30-minute reminder is the backstop against a forgotten recorder. |
| E4 | App quits or crashes mid-meeting | Segments on disk are complete files and stay valid; the existing crash-detection slack closes the session and the pipeline picks it up. |
| E5 | Transcription provider down, or no key | Raw-first already: audio is the durable artifact, `## Transcript` simply lags, the next pass retries. Nothing is lost to a network error. |
| E6 | Summary model down | The transcript still lands. The summary is best-effort and retried per segment, never a blocker. |
| E7 | User deletes the note mid-meeting | Stop appending, keep recording to disk. Deleting is a decision, not a glitch — don't resurrect it. |
| E8 | User types inside `## Transcript` | Their text stays; appends go to the end of the section. |
| E9 | Two overlapping events | One recording at a time; the second offer declines with a reason rather than stealing the stream. |
| E10 | Output device changes mid-meeting (headphones in) | The stream must survive a device switch — verify explicitly, it is the most common mid-meeting event. |
| E11 | `private: true` | Recording stays allowed (the audio-memo posture: no *existing* note content is sent). The summary prompt carries the new transcript only — never the user's typed notes, which would leak note content to a provider. |
| E12 | Two-hour meeting | 24 segments, 24 appends. Long but correct; no cap needed. |

## Phases

**Phase 1 — native capture.** The Rust module, the permission request, segment
files on disk, the `recording:segment` event. Done when recording a real
meeting produces N complete files containing both sides of the conversation,
and the *existing* audio-memo pipeline consumes them unchanged. No note
behavior changes yet — this phase is provably finished without touching
TypeScript policy.

**Phase 2 — the live note.** The note is created at start, named from the
event; each closed segment appends to `## Transcript`; calendar and ⌘K
triggers. Done when a meeting leaves behind a note that filled itself, with
the user's own typing preserved in the same document.

**Phase 3 — the rolling summary.** `## Resumen` gains the key points of each
closed segment. Done when a 30-minute meeting yields a readable summary
without opening the transcript.

## Risks

1. **Concurrent writes.** The user types in the note while the app appends to
   it. This is the one genuinely new problem in the plan and it gates Phase 2.
   Verify the editor/file path holds under an append arriving mid-keystroke.
   If it can't be made safe, the fallback is clean: transcript and summary go
   to a child note linked from the one the user types in.
2. **A new permission changes what Reflect is.** Screen recording is a heavier
   ask than microphone or calendar. Request it only when the feature is first
   used, never at launch, and state plainly that it is how macOS exposes
   system audio.
3. **Cost at 5-minute granularity** against a metered transcription provider.
4. **Scope.** This is the edge of "note app". The recording indicator is the
   whole UI; anything more belongs to a different product.

## Open decisions

- **D1 — mic capture.** `SCStream`'s microphone capture (macOS 15+) versus
  mixing the mic in with `AVAudioEngine`. Confirm the API surface before
  committing; the first is dramatically less code.
- **D2 — what the summary sees.** Only the latest segment, or the whole
  meeting so far. Proposal: the latest segment plus the bullets already
  written, so context stays coherent and cost stays flat.
- **D3 — one track or two.** One mixed track forecloses diarization. Proposal:
  one; revisit only if speaker labels become a real need rather than a
  temptation.
- **D4 — where the note lives.** Proposal: `notes/`, backlinked from the daily
  note — exactly what audio memos do. No new convention.
