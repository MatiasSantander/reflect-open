import { importAudioMemo } from '../graph/commands.ts'
import { errorMessage } from '../errors.ts'
import {
  startMeetingRecording,
  stopMeetingRecording,
  subscribeRecordingSegments,
  type RecordingSegment,
  type RecordingStarted,
} from '../recording/commands.ts'
import type { Unlisten } from '../ipc/bridge.ts'
import { audioMemoIdentity, audioMemoPartPath, type AudioMemoIdentity } from './audio-memo.ts'

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface MeetingSession {
  /** The identity every segment of this meeting is stored under. */
  memo: AudioMemoIdentity
  /** Where the capture is writing before import, for diagnostics. */
  stagingDir: string
  /** The input the microphone half opened. */
  micDevice: string
  /** Stop the capture and release the subscription. Safe to call twice. */
  stop: () => Promise<void>
}

export interface StartMeetingSessionInput {
  /** How long each segment runs. The summary cadence follows from this. */
  segmentMs: number
  /** `GraphInfo.generation` — pins every write to the issuing graph. */
  generation: number
  /** Called once a segment is in the graph, with its stored path. */
  onSegment?: ((segment: RecordingSegment, path: string) => void) | undefined
  /** Called when a segment could not be imported; the file stays in staging. */
  onError?: ((message: string) => void) | undefined
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
  let unlisten: Unlisten | null = null
  let stopped = false

  // `recording_stop` returns as soon as the capture thread is told to finish,
  // but that thread closes and announces the final segment of *each* track
  // afterwards. Unsubscribing when the call resolves would therefore drop the
  // end-marked segments — and with them the marker the pipeline reads as
  // "this session ended cleanly" rather than "it crashed".
  const endedTracks = new Set<RecordingSegment['track']>()
  let sessionEnded: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    sessionEnded = resolve
  })

  // Subscribe before starting: a segment announced between the two calls
  // would otherwise be lost, and with it a minute of the meeting.
  unlisten = await subscribeRecordingSegments((segment) => {
    const path = audioMemoPartPath(memo, segment.part, segment.end, segment.track)
    void importAudioMemo(segment.path, path, input.generation).then(
      () => input.onSegment?.(segment, path),
      (cause: unknown) => input.onError?.(errorMessage(cause)),
    )
    if (segment.end) {
      endedTracks.add(segment.track)
      if (endedTracks.size >= TRACKS_PER_SESSION) {
        sessionEnded()
      }
    }
  })

  let started: RecordingStarted
  try {
    started = await startMeetingRecording(input.segmentMs)
  } catch (cause) {
    unlisten()
    throw cause
  }

  return {
    memo,
    stagingDir: started.stagingDir,
    micDevice: started.micDevice,
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
    },
  }
}
