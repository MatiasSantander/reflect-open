# Plan 25 — Meeting notes (capture, transcribe, summarize)

**Goal:** a meeting becomes one note that writes itself while it happens.
Reflect notices the call, records both sides, and every few minutes the
transcript and a running summary of key points land in the note — in the same
document the user is typing their own notes into.

**Depends on:** the audio-memo pipeline
(`packages/core/src/actions/audio-memo.ts`, `audio-memo-session.ts`) — the
capture-family action alongside Plan 11's link capture — which supplies
segmented sessions, the per-part transcript cache and the retry posture. The
shipped calendar integration names the note. Plan 10 supplies the model the
summary runs on.

**Status:** draft; the API choices below are settled against the macOS SDK
headers and two open-source implementations, not assumed.

## Where we stand

Most of the pipeline exists. Audio memos are a meeting recorder in everything
but their input, their trigger and their output shape:

| Already there | Where |
|---|---|
| Segmented sessions: the recorder rotates and each segment lands as a complete file (`<base>.part-NNN.<ext>`, last one `-end`-marked) | `audio-memo-session.ts` (`AUDIO_MEMO_SEGMENT_MS`) |
| Per-part transcript cache under `.reflect/transcripts/` — a pass that dies at part 7 of 12 never re-bills the first six | `audio-memo-session.ts` |
| Transcription with retries, oversize/rejection handling, tombstones | `audio-memo.ts` |
| Note creation, title from a small-model pass, daily-note backlink | `audio-memo.ts` |
| Crash detection for a session that never closed; a live-mic reminder | `audio-memo-session.ts` |
| A registry of mounted editors by note path, used by commands that insert into the open note (*Attach file…*) | `apps/desktop/src/editor/editor-handle-registry.ts` |
| The day's events, with times, attendees and join links | `packages/core/src/calendar/` |

What is missing:

1. **The other side of the conversation.** Desktop recording is the webview's
   `MediaRecorder` over `getUserMedia({ audio: true })` — the default input
   device. On a call that captures the user and nobody else.
2. **A trigger.** Recording starts from the sidebar button only.
3. **Live output.** The note is written when the session closes
   (`isSessionReady` requires `isSessionClosed`), not while it runs.
4. **A rolling summary.** Nothing summarizes a transcript in progress.

## Scope

**In:** native capture of the meeting app's audio and the microphone as two
tracks; automatic start from sustained two-way audio, with ⌘K as the manual
path; a meeting note whose `## Transcript` and `## Resumen` fill as the
meeting runs; reuse of the existing transcription pipeline.

**Out:** diarization and speaker identification (two tracks already answer
"who" well enough); screenshots and OCR; window-title sniffing; iOS; local
transcription (worth doing, independently useful, not this plan); any new
screen — the recording indicator that exists today is the whole UI.

## Design contracts

### 1. Core Audio, not ScreenCaptureKit — because this codebase is Rust

Both routes reach system audio and both need the same TCC permission
("Screen & System Audio Recording"). They differ sharply in how much
Objective-C a Rust caller has to write:

| Piece | API | Surface |
|---|---|---|
| Capture a process's audio | `AudioHardwareCreateProcessTap` | C (`extern "C"`, `OSStatus`) |
| Describe what to tap | `CATapDescription` | Objective-C — one class, three initializers |
| Read samples | `AudioDeviceCreateIOProcID` | C, function-pointer callback |
| Write `.m4a` with format conversion | `ExtAudioFileCreateWithURL` / `…Write` | C |
| Notice who is using audio | CoreAudio property listeners | C |

ScreenCaptureKit instead requires **implementing an Objective-C protocol**
(`SCStreamOutput`) to receive sample buffers, plus completion-handler APIs —
the hard end of `objc2`. That is precisely why Humla, the closest comparable
project, ships its capture as a **Swift sidecar**; this repo has decided
against Swift (*"the codebase is pure Rust today and stays that way"*), so the
API that is friendly to non-Objective-C callers is the right one.

**Verified, not assumed.** A standalone Rust spike (`.context/tap-spike`,
~300 lines against `objc2-core-audio` 0.3.2) builds the full chain — tap →
aggregate device → `IOProc` → WAV — and captured 7.0 s of real system audio on
macOS 26.6.2 on the first run: 653 `IOProc` callbacks, 334 336 frames,
152 470 non-silent samples. The crates the repo already pins at 0.3.x cover
every call; no hand-written FFI was needed anywhere.

One caveat on that run: it inherited the launching terminal's TCC context, so
it proves the **code** is right, not that an app bundle gets consent for free.
T1 stays open until the same chain runs inside the signed app.

Tapping also beats whole-system capture on the merits: `CATapDescription`'s
`initStereoMixdownOfProcesses:` records **only the meeting app**, so music and
other apps' notifications never enter the recording, and
`initExcludingProcesses:` keeps Reflect out of its own capture.

### 2. Two tracks

The meeting app's audio and the microphone are recorded as two files per
segment. This was settled three ways: `SCStream` delivers the microphone as a
*separate* output type in its own native format (so nothing is mixed for free
on either route); `SCRecordingOutputConfiguration.mixesAudioWithMicrophone` is
macOS 27+, unavailable to the versions this app runs on; and both open-source
implementations surveyed chose two tracks independently, for the reason that
matters here — the user's voice stays distinct from everyone else's.

**Verified end to end.** The spike now records both tracks segmented: three
parts per track rotating on a timer, the last marked `-end`, named on the
audio-memo convention (`audio-memo-<date>-<hhmmss>-<ms>.part-NNN[-end].<track>.wav`),
with both tracks carrying signal. Drift between them stayed at 0.00–0.09 s per
part. `cpal` covers the microphone, so that half needs no Objective-C at all.

Mixing by hand would mean format conversion, resampling and a sample-buffer
mixer. Two `ExtAudioFile` writers mean none of that. The cost is a second
transcription call per segment; the gain is **who said it**, with no
diarization at all. `transcribeAudio` returns plain text with no timestamps,
so the two transcripts can't be interleaved chronologically — at five-minute
granularity they don't need to be, and each segment appends as two labelled
entries.

### 3. Detection and capture are one subsystem

Finding what to tap and noticing that a call started are the *same query*: the
process list is `kAudioHardwarePropertyProcessObjectList`, and each entry
carries `kAudioProcessPropertyBundleID`,
`kAudioProcessPropertyIsRunningInput` and
`kAudioProcessPropertyIsRunningOutput`.

**Measured, not assumed.** A probe sampling every 500 ms over a 10-second
window, run against real calls:

| Observed | Reading |
|---|---|
| A dictation app held input 100%, output 0% | input alone is never a conversation — the cheapest rejection there is |
| Output sat at 100% for anything making sound | output does not discriminate; **the signal is the input percentage** |
| A live call held input 95–100%; playback sat at 0–50% | the threshold has daylight on both sides |
| Instantaneous flags flapped between both/input/output within seconds of each other | sampling the instant is unusable; the rolling window is what makes the signal legible |
| Two processes reported a conversation at once — a browser carrying the call, and the native Slack app ringing beside it | **a false positive, not concurrency.** One person holds one conversation at a time, so a second candidate is noise: a ringtone, a notification, another app playing. Only one session runs. |

So: a conversation is one process holding **both** input and output above ~80%
across the window. Rust reports the measurement; TypeScript owns the
thresholds and what they mean.

That ringing app is also why the capture must scope to the conversation's
process — `CATapDescription`'s `initStereoMixdownOfProcesses:` rather than the
global variant the probe used. A global tap records the notification over the
meeting.

**The boundary between consecutive calls is the harder problem, and audio
cannot solve it.** The same probe watched input fall to 50% and climb back
inside one call, which is why a session needs a grace period before it closes
— and that grace is exactly what merges one call into the next when they run
back to back. The failure is not hypothetical: it is the one this plan's
author hit in the system this is ported from, where a finished call was
absorbed into the previous session.

The window title settles it. `Felipe Villagrán - ADIPA - Slack` becoming
`Constanza Simon - ADIPA - Slack` is a new conversation even though the audio
never stopped, while a dip under an unchanged title is the same call
breathing. So: audio opens and closes a session, and **a title change splits
one**.

Window titles are the other half, and they carry what audio cannot: the
Slack huddle window is titled with the person on the other end, and a Meet
tab's URL carries the meeting code that matches a calendar event's
`hangoutLink` **exactly** — binding by code rather than by "what is scheduled
right now", which is the binding that mis-attributes a call that interrupts a
meeting. `CGWindowListCopyWindowInfo` supplies both, but only to a process
holding the screen-recording permission: the same probe read 9 titles of 68
windows from a terminal, and the rest came back redacted. The app has that
permission for the capture already; nothing else needs to change.

One caveat the probe surfaced and did not settle: a browser plays call audio
from a *helper* process whose windows belong to its parent, so matching a
title to a conversation has to group by the containing `.app`, not by PID.

### 4. The note is live, and the user owns it

The note is created when recording starts, not at the end, so the user can
type in it during the meeting. Its title comes from a calendar event in
progress when there is one, from the timestamp otherwise; the existing
small-model pass can rename it from the transcript afterwards, exactly as it
already does for audio memos. **The calendar names; it never starts or stops
anything.**

Appends go to the end of `## Transcript` and `## Resumen`, and must not move
the user's cursor. How they are written depends on whether the note is open:

- **Open** → through its `NoteEditorHandle` from the editor registry, as an
  ordinary insertion (what *Attach file…* already does). The session sees an
  edit, not an external change.
- **Closed** → a plain file write.

This routing is what makes the feature usable, and it is not optional. A
direct file write under an open editor hits
`note-session-state.ts`'s external-change path: a clean buffer adopts the
content, but a **dirty** one parks it, pauses saves and asks *Keep mine /
Load theirs*. Nothing is ever lost — the code's own comment is *"Never clobber
unsaved edits"* — but a user typing through a meeting would face that prompt
every five minutes.

### 5. The segment is the clock

Rotation every 5 minutes: a closed segment is transcribed, appended,
summarized, appended. That *is* the "summary every five minutes" behaviour —
no second timer, no partial-transcript machinery. The cost is ~24
transcriptions (two tracks) and ~12 summaries per hour: free against a local
model, noticeable against a metered one. The existing 20-minute constant
exists for provider size limits; 5 minutes sits far under all of them.

A crash loses the open segment — up to five minutes. `AVAssetWriter`-style
fragmented output (`ExtAudioFile` writes incrementally, so a truncated file
stays readable) keeps that bounded; verify the written file survives a kill.

### 6. Starting and stopping

**Start:** sustained two-way audio raises a cancelable countdown — *"Recording
'ADIPA <> Aaron Wade' in 3… [Cancel]"* — the shape bitácora validated in daily
use. ⌘K → "Record meeting" is always available for what detection misses.

**Stop**, in priority order: the user; the tapped process disappearing
(immediate — the app quit or the tab closed); two-way audio absent for a grace
window of about 90 seconds. The grace is not caution for its own sake — muting,
plugging in headphones and a network blip all interrupt the streams, and
without it a single meeting becomes three notes.

**Getting it wrong is cheap**, which is what licenses starting on a weak
signal: a session that ran briefly and whose note the user never typed in is
trashed automatically. The test is bitácora's seed hash — store the hash of
what Reflect wrote; if the file still hashes to it, there is no human content.
One typed character protects the note forever.

## Prior art

Two open-source implementations were read before choosing, and both inform the
contracts above:

- [**Humla**](https://github.com/michaelwilhelmsen/humla) — Tauri 2 + Rust with
  a **Swift sidecar**: ScreenCaptureKit for system audio, `AVAudioEngine` for
  the microphone, two separate streams, Microphone + Screen Recording
  permissions, and **no automatic detection** (manual record/stop).
- [**Fly on the Wall**](https://github.com/swarnavspujari/fly-on-the-wall) —
  Tauri + Rust, **Core Audio process tap** (macOS 14.2+), two tracks, start by
  clicking a calendar event. Its README carries the trap this plan would
  otherwise have discovered the hard way: *"macOS only delivers real audio to
  that tap if the app has a stable code-signing identity."*

## Known traps

| | Trap | Handling |
|---|---|---|
| T1 | **Resolved — but only with a stable signing identity.** Every tap call returns `noErr` even when consent is missing, and a denied tap delivers digital silence, so there is no error path at all. Worse, an **ad-hoc-signed** build re-registers as a different app on every rebuild: macOS keeps showing the permission as granted while the authorization silently stops applying. Verified end to end on macOS 26.6.2 — the probe reported `silentWhilePlaying` against an ad-hoc build and `granted` against one signed with a stable identity, and the grant then **survived a full rebuild + reinstall untouched**. Development therefore needs a signing identity, not notarisation: a self-signed code-signing certificate is enough (`openssl req -x509 … -addext "extendedKeyUsage=critical,codeSigning"`, exported as PKCS#12 with `-certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1` because `security` cannot read OpenSSL 3's defaults, imported with `-T /usr/bin/codesign`, trusted with `security add-trusted-cert -r trustRoot -p codeSign`), passed to the build as `APPLE_SIGNING_IDENTITY`. Keep the consent probe regardless: it is the only thing that can tell a quiet room from a dead tap. |
| T5 | **Confirmed, and handled.** A tap goes quiet when nothing is playing — it delivers no callbacks rather than silence, so the system track ends up shorter than wall time and drifts out of alignment with the mic track | Pad the system track to the clock: compare frames written against elapsed time and insert silence when it falls behind. Fly on the Wall does this explicitly ("pad-to-clock: taps go quiet with the render pipeline"); the spike reproduced the failure and the fix — in true silence the system track still measured 3.0 s per part, aligned with the microphone to 0.00 s. |
| T4 | Permission | Requested with `CGRequestScreenCaptureAccess` on first use, never at launch, after `CGPreflightScreenCaptureAccess`. Confirm whether the hardened runtime needs an entitlement and the bundle a usage string — the calendar integration needed both. |

## Edge cases

| # | Case | Behaviour |
|---|------|-----------|
| E1 | Permission denied | Say so and record the microphone only, visibly. Never silently capture half a conversation. |
| E2 | Permission revoked mid-recording | Close the session cleanly, keep every segment already written, surface why. |
| E3 | Muting, headphones, a network blip | Covered by the stop grace window; the recording does not split. |
| E4 | App quits or crashes mid-meeting | Closed segments are complete files. With no `-end`, the existing crash-detection slack closes the session and the normal pass finishes it. |
| E5 | Transcription provider down, or no key | Raw-first: audio is the durable artifact, the transcript lags, the next pass retries. |
| E6 | Summary model down | The transcript still lands; the summary is best-effort, retried per segment, never a blocker. |
| E7 | User deletes the note mid-meeting | Stop appending, keep recording to disk. Deleting is a decision, not a glitch. |
| E8 | User types inside a managed section | Their text stays; appends land at the section end and never move the selection. |
| E9 | A false positive (a video playing while dictating) | The countdown is the first defence; the seed-hash discard is the second. |
| E10 | Slack huddle straight into a Zoom, no gap | Two-way audio never stopped, so it stays one session. Splitting by bundle id would cut a meeting in half whenever someone shares from another app. |
| E11 | `private: true` | Recording stays allowed (the audio-memo posture: no *existing* note content is sent). The summary prompt carries the new transcript only — never the user's typed notes. |
| E12 | No headphones | The microphone track picks up the speakers and the transcript duplicates the other side. bitácora filters this at the text level (similarity, containment, sentence); port that only if it bites. |
| E13 | Two-hour meeting | 24 segments per track. Long but correct; no cap needed. |

## Phases

**Phase 1 — the capture subsystem.** The Rust module: process listener,
detection policy surface, tap + aggregate device + `IOProc`, two
`ExtAudioFile` writers, five-minute rotation, the `recording:segment` event.
The countdown card and ⌘K. The track-aware part naming (T3). Done when a real
meeting leaves N complete file pairs **containing both sides**, consumed by the
existing audio-memo pipeline, and when a false positive discards itself.

**Phase 2 — the live note.** Created at start, named from the calendar,
appended per segment through the editor handle when open. Done when a meeting
leaves a note that filled itself with the user's own typing preserved in it.

**Phase 3 — the rolling summary.** `## Resumen` gains each closed segment's
key points. Done when a 30-minute meeting is understandable without opening
the transcript.

## Risks

1. **T1 and T2 are where the time goes.** A silent recording and a
   mis-sequenced aggregate device both fail quietly. Budget the first day for
   proving audio actually lands.
2. **A new permission changes what Reflect is.** Screen and system audio
   recording is a heavier ask than microphone or calendar. Request it on first
   use, and say plainly that it is how macOS exposes system audio.
3. **Cost at five-minute granularity** against a metered transcription
   provider — the argument for local transcription, separately.
4. **Scope.** This is the edge of "note app". The recording indicator is the
   whole UI; anything beyond it belongs to a different product.

## Open decisions

- **D1 — the debounce window.** How long two-way audio must persist before the
  countdown appears. Proposal: start around 30 s and tune from use; a missed
  meeting costs more than a cancelled countdown.
- **D2 — what the summary sees.** Only the latest segment, or the whole
  meeting so far. Proposal: the latest segment plus the bullets already
  written — coherent context, flat cost.
- **D3 — labelling the tracks.** `system` and `mic` are "them" and "you" only
  by convention. Proposal: label them that way and accept the edge (a shared
  room microphone carries everyone) rather than inferring anything.
- **D4 — where the note lives.** Proposal: `notes/`, backlinked from the daily
  note — exactly what audio memos do. No new convention.
