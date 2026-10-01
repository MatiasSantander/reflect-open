import { z } from 'zod'
import { call } from '../ipc/invoke.ts'

/**
 * Typed bindings for the Rust system-audio capability — Core Audio process
 * taps (`apps/desktop/src-tauri/src/recording.rs`). Rust answers only
 * "can this machine tap system audio" and "does a tap actually deliver it";
 * deciding that a meeting started and what the audio becomes is policy here
 * in core (docs/plans/25-meeting-notes.md).
 */

/**
 * What a throwaway tap observed.
 *
 * The distinction that matters is `silentWhilePlaying`: every tap API returns
 * success even when the user denied "Screen & System Audio Recording", and a
 * denied tap delivers digital silence rather than an error. Silence *while
 * the default output device is rendering for someone* is the only evidence a
 * denial ever produces, so it must never be reported as "the room was quiet".
 */
export const systemAudioPreflightSchema = z.discriminatedUnion('kind', [
  /** Non-silent samples arrived: system audio works. */
  z.object({ kind: z.literal('granted') }),
  /** Consent is missing, or the binary has no stable code-signing identity. */
  z.object({ kind: z.literal('silentWhilePlaying') }),
  /** Nothing was playing, so silence proved nothing — ask again with audio. */
  z.object({ kind: z.literal('inconclusive') }),
  /** This OS has no process taps (before macOS 14.2), or isn't macOS. */
  z.object({ kind: z.literal('unsupported') }),
  /** A Core Audio call refused outright — the rare honest failure. */
  z.object({ kind: z.literal('failed'), message: z.string() }),
])

export type SystemAudioPreflight = z.infer<typeof systemAudioPreflightSchema>

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

/** Can system audio be captured at all here? Never prompts, never records. */
export async function systemAudioSupported(): Promise<boolean> {
  return await call('recording_system_audio_supported', {}, z.boolean())
}

/**
 * Listen for `durationMs` and classify what arrived. Clamped by Rust to a
 * sane window; a second or two is enough once something is playing.
 */
export async function probeSystemAudio(durationMs: number): Promise<SystemAudioPreflight> {
  return await call('recording_system_audio_preflight', { durationMs }, systemAudioPreflightSchema)
}

/**
 * Is this outcome one the user can fix by granting the permission? Separates
 * the actionable denial from "we couldn't tell" and "this Mac can't".
 */
export function needsSystemAudioPermission(preflight: SystemAudioPreflight): boolean {
  return preflight.kind === 'silentWhilePlaying'
}
