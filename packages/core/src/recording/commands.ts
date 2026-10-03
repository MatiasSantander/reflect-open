import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'
import { call } from '../ipc/invoke.ts'

/**
 * Typed bindings for the Rust system-audio capability — Core Audio process
 * taps (`apps/desktop/src-tauri/src/recording.rs`). Rust answers only
 * "can this machine tap system audio" and "does a tap actually deliver it";
 * deciding that a meeting started and what the audio becomes is policy here
 * in core (docs/plans/25-meeting-notes.md).
 */

/**
 * A command that answers nothing.
 *
 * Rust's `()` crosses the bridge as JSON `null`, so this is `z.null()` — the
 * same spelling the settings and embeddings bindings use. A schema that
 * insists on `undefined` instead rejects every such answer, and for a stop
 * that means the capture halts (Rust already acted) while every decision
 * hanging off the stop never runs.
 */
const voidSchema = z.null()

/**
 * Has the user granted "Screen & System Audio Recording"? Never prompts.
 *
 * Worth checking even though {@link probeSystemAudio} would also catch a
 * denial: this answers instantly and without making noise, so a settings row
 * can render the real state before anyone plays anything.
 */
export async function systemAudioAccessGranted(): Promise<boolean> {
  return await call('recording_system_audio_access_granted', {}, z.boolean())
}

/**
 * Trigger the macOS prompt, resolving with whether capture is now allowed.
 * The OS asks **once ever** per app identity, so a `false` here can mean
 * "they just said no" or "they said no months ago" — either way the only
 * route back is System Settings, never a second prompt.
 */
export async function requestSystemAudioAccess(): Promise<boolean> {
  return await call('recording_request_system_audio_access', {}, z.boolean())
}

/**
 * One finished recording segment, announced the moment its file is closed.
 *
 * The payload is deliberately placeless: Rust writes into a staging directory
 * and reports what it wrote, leaving where it belongs in the graph to core —
 * the same split `audio_memo_import` already serves for the iOS recorder. So
 * the track-aware naming lives here, never in the capture.
 */
export const recordingSegmentSchema = z.object({
  /** 1-based position in the session. */
  part: z.number().int().positive(),
  /** The last segment of a cleanly stopped session. */
  end: z.boolean(),
  /** `system` is what the meeting played, `mic` is what the user said. */
  track: z.enum(['system', 'mic']),
  /** Absolute staging path of the finished file. */
  path: z.string(),
  frames: z.number().int().nonnegative(),
  /**
   * Samples above room tone. On the `system` track this is the evidence that
   * anyone else was in the conversation: a session whose system side stayed
   * silent had nobody on the other end.
   */
  loud: z.number().int().nonnegative(),
  rate: z.number().int().positive(),
})

export type RecordingSegment = z.infer<typeof recordingSegmentSchema>

const recordingStartedSchema = z.object({
  stagingDir: z.string(),
  /** What the tap delivers at, before the capture resamples for transcription. */
  systemRate: z.number().int().nonnegative(),
  micRate: z.number().int().nonnegative(),
  /** The input the microphone half opened, for a "recording from…" line. */
  micDevice: z.string(),
})

export type RecordingStarted = z.infer<typeof recordingStartedSchema>

/**
 * Start capturing system audio and the microphone as two tracks, rotating
 * every `segmentMs`. Rejects when a session is already running — a second
 * recorder would fight the first for the device.
 *
 * Nothing lands in the graph from this call: segments arrive as
 * `recording:segment` events and it is the caller that imports them.
 */
export async function startMeetingRecording(segmentMs: number): Promise<RecordingStarted> {
  return await call('recording_start', { segmentMs }, recordingStartedSchema)
}

/**
 * Stop the session, closing the final segment with `end: true`. Idempotent,
 * because the user pressing stop and a meeting ending can race.
 */
export async function stopMeetingRecording(): Promise<void> {
  await call('recording_stop', {}, voidSchema)
}

/** Subscribe to finished segments. Returns the unsubscribe. */
export function subscribeRecordingSegments(
  handler: (segment: RecordingSegment) => void,
): Promise<Unlisten> {
  return getBridge().listen('recording:segment', (payload) => {
    handler(recordingSegmentSchema.parse(payload))
  })
}

/**
 * One process holding the microphone open, with the windows of the app that
 * contains it.
 *
 * Rust reports the measurement and nothing more. Whether this adds up to a
 * call — which apps count, which window titles look like a conversation, how
 * long to let the situation settle — is policy here (Plan 25, contract 3).
 */
export const callCandidateSchema = z.object({
  /** e.g. `com.tinyspeck.slackmacgap.helper`. */
  bundleId: z.string(),
  pid: z.number().int(),
  /**
   * The `.app` containing the process. A browser plays call audio from a
   * helper whose windows belong to its parent, so this is what groups them.
   */
  app: z.string(),
  /**
   * That app's on-screen window titles. Empty when macOS redacted them, which
   * it does for any process without the screen-recording permission — so an
   * empty list means "cannot see", never "no windows".
   */
  windows: z.array(z.string()),
})

export type CallCandidate = z.infer<typeof callCandidateSchema>

/** Everything with the microphone open right now. Cheap enough to poll. */
export async function callCandidates(): Promise<CallCandidate[]> {
  return await call('recording_call_candidates', {}, z.array(callCandidateSchema))
}

/**
 * Append a line to the meeting trace.
 *
 * A capture runs for an hour inside an app with no console, so without this
 * the only honest answer to "did it import?" is a shrug. Best-effort: a
 * failed trace is swallowed, because losing a log line must never disturb a
 * recording.
 */
export async function traceRecording(line: string): Promise<void> {
  try {
    await call('recording_trace', { line }, voidSchema)
  } catch {
    // Deliberately silent — see above.
  }
}
