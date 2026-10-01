import { deleteAudioMemo, importAudioMemo, readAsset, readAssetBinary } from '../graph/commands.ts'
import { hasBinaryIpc } from '../ipc/bridge.ts'
import { base64ToBytes } from '../lib/base64.ts'
import { errorMessage } from '../errors.ts'
import {
  startMeetingRecording,
  traceRecording,
  stopMeetingRecording,
  subscribeRecordingSegments,
  type RecordingSegment,
} from '../recording/commands.ts'
import type { Unlisten } from '../ipc/bridge.ts'
import { audioMemoIdentity, audioMemoPartPath, type AudioMemoIdentity } from './audio-memo.ts'
import {
  appendSummary,
  appendTask,
  appendTranscript,
  discardMeetingNote,
  openMeetingNote,
} from './meeting-note.ts'

/**
 * A meeting recording session: the capture runs in Rust, and this is the
 * half that decides where its output lands (Plan 25).
 *
 * The capture writes finished segments into a staging directory and
 * announces each one; this module copies them into `audio-memos/` under the
 * session's identity, after which they are ordinary audio-memo segments and
 * the existing transcription pipeline owns them — retries, the per-part
 * cache, the tombstone contract, all unchanged.
 *
 * Raw-first, like every capture action here: a segment that fails to import
 * stays in staging and is reported, never silently dropped, because the file
 * on disk is the only copy of a minute of someone's meeting.
 */

/**
 * How long each segment runs. Five minutes is the cadence the summary
 * follows — a closed segment is transcribed, appended, summarised, appended —
 * and at 16 kHz mono it keeps a segment near 10 MB, inside every
 * transcription provider's request cap with room to spare.
 */
export const MEETING_SEGMENT_MS = 5 * 60_000

/** The capture writes one file per track per position: system, then mic. */
const TRACKS_PER_SESSION = 2

/** How long `stop` waits for the final segments before giving up on them. */
const END_SEGMENT_GRACE_MS = 5_000

/**
 * Below this many audible samples across the whole session, the `system`
 * track heard nobody: a join dialog opened and closed, a call that never
 * connected, a detector that fired on the wrong thing. A tenth of a second of
 * sound at 16 kHz, which room tone does not reach because the count only
 * includes samples well above it.
 */
const SOMEONE_ELSE_WAS_THERE = 1_600

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface MeetingSession {
  /** The identity every segment of this meeting is stored under. */
  memo: AudioMemoIdentity
  /** Stop the capture and release the subscription. Safe to call twice. */
  stop: () => Promise<void>
}

export interface StartMeetingSessionInput {
  /** How long each segment runs. The summary cadence follows from this. */
  segmentMs: number
  /**
   * What to call the note. Detection reads it off the call's window; without
   * one the note is named for its time and renamed later from what was said.
   */
  title?: string | undefined
  /**
   * Transcribe each segment as it lands and append it to the note. Omitted,
   * the session only records — useful when no provider is configured, and the
   * audio is still on disk for a later pass.
   */
  transcribeSegment?:
    | ((segment: RecordingSegment, audio: Uint8Array) => Promise<string>)
    | undefined
  /**
   * Summarise a stretch of transcript into the points worth noting. Called
   * once per rotation, after both tracks of that segment have landed, so the
   * model sees the whole exchange rather than one side of it.
   */
  summarise?:
    | ((
        segment: string,
        soFar: readonly string[],
      ) => Promise<{ points: string[]; tasks: string[] }>)
    | undefined
  /** `GraphInfo.generation` — pins every write to the issuing graph. */
  generation: number
  /** Called once a segment is in the graph, with its stored path. */
  onSegment?: ((segment: RecordingSegment, path: string) => void) | undefined
  /** Called when a segment could not be imported; the file stays in staging. */
  onError?: ((message: string) => void) | undefined
  /** Called when the session was dropped because nobody else was heard. */
  onDiscarded?: (() => void) | undefined
}

/**
 * Start capturing, importing each finished segment as it arrives.
 *
 * The session's identity is minted here rather than in Rust: the naming
 * convention is a property of the graph, and the capture has no business
 * knowing it. `audio/wav` because that is what the capture writes — 16 kHz
 * mono, which is what transcription wants and what keeps a five-minute
 * segment inside every provider's size cap.
 */
export async function startMeetingSession(
  input: StartMeetingSessionInput,
): Promise<MeetingSession> {
  const memo = audioMemoIdentity(new Date(), 'audio/wav')
  // The note opens before the first second is recorded: its whole reason for
  // existing early is that the user types into it *during* the meeting.
  await openMeetingNote(memo, input.title?.trim() || memo.title, input.generation)
  let unlisten: Unlisten | null = null
  let stopped = false

  // `recording_stop` returns as soon as the capture thread is told to finish,
  // but that thread closes and announces the final segment of *each* track
  // afterwards. Unsubscribing when the call resolves would therefore drop the
  // end-marked segments — and with them the marker the pipeline reads as
  // "this session ended cleanly" rather than "it crashed".
  const endedTracks = new Set<RecordingSegment['track']>()
  // What the far end actually produced, and where every segment landed, so a
  // session nobody else spoke in can be taken back out again.
  let heardFromThem = 0
  const imported: string[] = []
  // Imports in flight — the copy into the graph only, never the
  // transcription chained onto it. The discard decision needs every segment
  // to have landed, because a short call whose only segment was still
  // importing reads as a call nobody answered and deletes itself. It must
  // *not* need the transcription: an hour-long meeting still being
  // transcribed cannot be the reason the next one goes unrecorded.
  const landing = new Set<Promise<void>>()
  // Both sides of the segment being assembled, and the points already in the
  // note — the summary runs once per rotation, not once per track, because
  // half a conversation summarises badly.
  let pendingSegment: { part: number; lines: string[] } | null = null
  const summarySoFar: string[] = []
  let sessionEnded: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    sessionEnded = resolve
  })

  // Subscribe before starting: a segment announced between the two calls
  // would otherwise be lost, and with it a minute of the meeting.
  unlisten = await subscribeRecordingSegments((segment) => {
    const path = audioMemoPartPath(memo, segment.part, segment.end, segment.track)
    const landed = importAudioMemo(segment.path, path, input.generation)
    landing.add(landed)
    void landed.finally(() => landing.delete(landed))
    void landed.then(
      async () => {
        imported.push(path)
        if (segment.track === 'system') {
          heardFromThem += segment.loud
        }
        void traceRecording(
          `core: imported part=${segment.part} ${segment.track} loud=${segment.loud} → ${path}`,
        )
        input.onSegment?.(segment, path)
        if (input.transcribeSegment === undefined) {
          return
        }
        try {
          // Core reads the bytes: the caller supplies a provider and a key,
          // not a way into the graph.
          const audio = hasBinaryIpc()
            ? await readAssetBinary(path, input.generation)
            : base64ToBytes(await readAsset(path, input.generation))
          const text = await input.transcribeSegment(segment, audio)
          await appendTranscript(
            memo,
            { track: segment.track, at: new Date(), text },
            input.generation,
          )
          void traceRecording(
            `core: transcribed part=${segment.part} ${segment.track} ${text.length} chars`,
          )
          await summariseWhenBothTracksLanded(segment, text)
        } catch (cause) {
          void traceRecording(
            `core: TRANSCRIBE FAILED part=${segment.part} ${segment.track} — ${errorMessage(cause)}`,
          )
        }
      },
      (cause: unknown) => {
        const message = errorMessage(cause)
        void traceRecording(
          `core: IMPORT FAILED part=${segment.part} ${segment.track} gen=${input.generation} — ${message}`,
        )
        input.onError?.(message)
      },
    )
    if (segment.end) {
      endedTracks.add(segment.track)
      if (endedTracks.size >= TRACKS_PER_SESSION) {
        sessionEnded()
      }
    }
  })

  /**
   * A rotation closes both tracks, so the summary waits for the second one.
   * Whichever arrives last carries the pair.
   */
  async function summariseWhenBothTracksLanded(
    segment: RecordingSegment,
    text: string,
  ): Promise<void> {
    if (input.summarise === undefined) {
      return
    }
    const label = segment.track === 'system' ? 'Them' : 'You'
    if (pendingSegment?.part !== segment.part) {
      pendingSegment = { part: segment.part, lines: [] }
    }
    pendingSegment.lines.push(`${label}: ${text}`)
    if (pendingSegment.lines.length < TRACKS_PER_SESSION) {
      return
    }
    const joined = pendingSegment.lines.join('\n\n')
    pendingSegment = null
    const summary = await input.summarise(joined, summarySoFar)
    for (const point of summary.points) {
      summarySoFar.push(point)
      await appendSummary(memo, { at: new Date(), text: point }, input.generation)
    }
    for (const task of summary.tasks) {
      await appendTask(memo, task, input.generation)
    }
    void traceRecording(
      `core: summarised part=${segment.part} into ${summary.points.length} points, ${summary.tasks.length} tasks`,
    )
  }

  void traceRecording(`core: session ${memo.base} starting, generation ${input.generation}`)
  try {
    await startMeetingRecording(input.segmentMs)
  } catch (cause) {
    unlisten()
    throw cause
  }

  return {
    memo,
    stop: async () => {
      if (stopped) {
        return
      }
      stopped = true
      await stopMeetingRecording()
      // Bounded, because a capture that died mid-segment will never announce
      // its end and the caller must still get its promise back. The segments
      // already on disk are unaffected either way: a session without the
      // marker is closed by the pipeline's own crash fallback.
      await Promise.race([ended, delay(END_SEGMENT_GRACE_MS)])
      unlisten?.()
      unlisten = null
      // Everything announced has to finish landing before the far end's
      // contribution can be judged. Transcribing and summarising are *not*
      // waited on: they run for as long as they need, writing into this
      // note, while the next meeting is free to start.
      await Promise.all(landing)

      // Nobody on the other end: take it back out before the transcription
      // pipeline ever sees it. This is what lets detection stay loose — a
      // wrong guess costs disk for a minute and nothing else.
      if (heardFromThem < SOMEONE_ELSE_WAS_THERE) {
        void traceRecording(
          `core: discarding ${memo.base} — system track heard ${heardFromThem} audible samples`,
        )
        await Promise.all(
          imported.map((path) =>
            deleteAudioMemo(path, input.generation).catch(() => {
              // A leftover file is harmless; a thrown error here would
              // swallow the stop the caller is waiting on.
            }),
          ),
        )
        await discardMeetingNote(memo, input.generation)
        input.onDiscarded?.()
      }
    },
  }
}
