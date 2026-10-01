import { useEffect, useRef } from 'react'
import {
  callCandidates,
  isCallCandidate,
  settledCandidate,
  type CallCandidate,
} from '@reflect/core'

/**
 * Watches for a call starting and tells the caller which app it is in
 * (Plan 25, contract 3).
 *
 * The shape is a poll rather than a subscription because Core Audio has no
 * "someone opened the microphone" notification worth the binding, and a
 * second of latency on something that runs for an hour costs nothing.
 */

/** How often to ask who has the microphone. */
const POLL_MS = 2_000

/**
 * How long to let the situation settle before recording.
 *
 * One Slack call rings in the desktop app *and* the browser, so the first
 * candidate seen may be the one merely ringing — recording it captures a
 * ringtone and then silence. This is also the window in which someone can
 * cancel, and the span in which a join dialog opened and abandoned closes
 * itself.
 */
const SETTLE_MS = 8_000

export interface CallWatchOptions {
  /** Off when a recording is already running: one conversation at a time. */
  enabled: boolean
  /**
   * A process to leave alone until it goes away. Stopping a recording by hand
   * while the call is still up would otherwise be undone within seconds, the
   * watcher seeing the same open microphone and starting over.
   */
  ignorePid?: number | null
  /** Fired once a call has settled, with the app that is carrying it. */
  onCall: (candidate: CallCandidate) => void
  /**
   * The process a recording is following. While set, the watcher looks for
   * that call *ending* instead of a new one starting.
   */
  recordingPid?: number | null
  /** Fired when the followed call has been gone long enough to be over. */
  onCallEnded?: (() => void) | undefined
}

/**
 * Polls the followed call must be absent for before the recording stops.
 *
 * Not caution for its own sake: the same probe that measured this watched a
 * microphone close and reopen inside one call, when someone muted and when
 * headphones were plugged in. Stopping on the first absent poll would cut a
 * meeting into pieces.
 */
const END_POLLS = 4

export function useCallWatch({
  enabled,
  ignorePid,
  onCall,
  recordingPid,
  onCallEnded,
}: CallWatchOptions): void {
  const onCallRef = useRef(onCall)
  const onEndedRef = useRef(onCallEnded)
  useEffect(() => {
    onCallRef.current = onCall
    onEndedRef.current = onCallEnded
  })

  // Following a recording: watch for its call to end.
  useEffect(() => {
    if (recordingPid === null || recordingPid === undefined) {
      return
    }
    let disposed = false
    let absent = 0
    const timer = setInterval(() => {
      void callCandidates()
        .then((candidates) => {
          if (disposed) {
            return
          }
          const live = candidates.some(
            (candidate) => candidate.pid === recordingPid && isCallCandidate(candidate),
          )
          absent = live ? 0 : absent + 1
          if (absent >= END_POLLS) {
            absent = 0
            onEndedRef.current?.()
          }
        })
        .catch(() => {
          // A failed poll is not evidence the call ended; try again.
        })
    }, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [recordingPid])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let disposed = false
    // Candidates seen when the countdown began, so a door that opens *during*
    // the wait is a different conversation starting rather than this one.
    let settling: CallCandidate[] | null = null
    let settlingSince = 0

    const tick = async (): Promise<void> => {
      const candidates = (await callCandidates()).filter(
        (candidate) => isCallCandidate(candidate) && candidate.pid !== ignorePid,
      )
      if (disposed) {
        return
      }
      if (candidates.length === 0) {
        settling = null
        return
      }
      if (settling === null) {
        settling = candidates
        settlingSince = Date.now()
        return
      }
      if (Date.now() - settlingSince < SETTLE_MS) {
        return
      }
      const survivor = settledCandidate(settling, candidates)
      settling = null
      if (survivor !== null) {
        onCallRef.current(survivor)
      }
    }

    const timer = setInterval(() => {
      void tick().catch(() => {
        // A failed poll is not worth surfacing: the next one is two seconds
        // away, and the manual command is always available.
      })
    }, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [enabled, ignorePid])
}
