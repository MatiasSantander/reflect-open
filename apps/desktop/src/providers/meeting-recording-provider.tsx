import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  errorMessage,
  MEETING_SEGMENT_MS,
  startMeetingSession,
  type GraphInfo,
  type MeetingSession,
} from '@reflect/core'

/**
 * The meeting recorder's React surface: one session at a time, started and
 * stopped from the command palette (Plan 25).
 *
 * Deliberately thin. The capture lives in Rust and the import policy in
 * `@reflect/core`; this only owns what React has to own — whether a session
 * is live, and the last failure worth showing.
 */
export interface MeetingRecordingValue {
  /** True while a meeting is being captured. */
  recording: boolean
  /** Why the last attempt failed. Cleared when a new one starts. */
  error: string | null
  /** Start a session, or stop the running one. */
  toggle: () => void
}

const MeetingRecordingContext = createContext<MeetingRecordingValue | null>(null)

export function useMeetingRecording(): MeetingRecordingValue {
  const value = use(MeetingRecordingContext)
  if (value === null) {
    throw new Error('useMeetingRecording must be used inside MeetingRecordingProvider')
  }
  return value
}

export interface MeetingRecordingProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function MeetingRecordingProvider({
  graph,
  children,
}: MeetingRecordingProviderProps): ReactElement {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<MeetingSession | null>(null)
  // Read at toggle time rather than captured: a graph switch mid-session must
  // not write the next segment into the graph the user just left.
  const generationRef = useRef(graph.generation)
  useEffect(() => {
    generationRef.current = graph.generation
  })

  // A capture outlives the component by default — the Rust thread holds the
  // devices — so unmounting has to stop it, or the microphone stays live.
  useEffect(() => {
    return () => {
      void sessionRef.current?.stop()
      sessionRef.current = null
    }
  }, [])

  // Starting is asynchronous, so "is a session live?" has three answers, and
  // a ref rather than state because the callback is created once. The token
  // is what lets a stop that lands mid-start discard the session that is
  // still being built, instead of adopting one the user already cancelled.
  const statusRef = useRef<'idle' | 'starting' | 'recording'>('idle')
  const tokenRef = useRef(0)

  const toggle = useCallback((): void => {
    if (statusRef.current === 'recording') {
      const live = sessionRef.current
      sessionRef.current = null
      statusRef.current = 'idle'
      setRecording(false)
      void live?.stop().catch((cause: unknown) => setError(errorMessage(cause)))
      return
    }
    if (statusRef.current === 'starting') {
      tokenRef.current += 1
      statusRef.current = 'idle'
      setRecording(false)
      return
    }
    const token = ++tokenRef.current
    statusRef.current = 'starting'
    setError(null)
    setRecording(true)
    void startMeetingSession({
      segmentMs: MEETING_SEGMENT_MS,
      generation: generationRef.current,
      onError: setError,
    }).then(
      (session) => {
        if (tokenRef.current !== token) {
          void session.stop()
          return
        }
        sessionRef.current = session
        statusRef.current = 'recording'
      },
      (cause: unknown) => {
        if (tokenRef.current !== token) {
          return
        }
        statusRef.current = 'idle'
        setRecording(false)
        setError(errorMessage(cause))
      },
    )
  }, [])

  return (
    <MeetingRecordingContext value={{ recording, error, toggle }}>
      {children}
    </MeetingRecordingContext>
  )
}
