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
  /** Fired once a call has settled, with the app that is carrying it. */
  onCall: (candidate: CallCandidate) => void
}

export function useCallWatch({ enabled, onCall }: CallWatchOptions): void {
  const onCallRef = useRef(onCall)
  useEffect(() => {
    onCallRef.current = onCall
  })

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
      const candidates = (await callCandidates()).filter(isCallCandidate)
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
  }, [enabled])
}
