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
  aiApiKeyForConfig,
  candidateTitle,
  errorMessage,
  MEETING_SEGMENT_MS,
  pickTranscriptionConfig,
  requestSystemAudioAccess,
  startMeetingSession,
  systemAudioAccessGranted,
  nameMeeting,
  summariseMeetingSegment,
  transcribeAudio,
  type GraphInfo,
  type MeetingSession,
} from '@reflect/core'
import type { AiProviderConfig } from '@reflect/core'
import { providerFetch } from '@/lib/provider-fetch.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useCallWatch } from '@/providers/call-watch.ts'

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
  /**
   * What the detector called the conversation, when it started itself. Null
   * for a recording the user began, and for a call whose window carried no
   * name yet — the transcript names those.
   */
  detectedAs: string | null
  /**
   * A call was spotted and recording begins at this epoch unless cancelled.
   * Null when nothing is pending.
   */
  startingAt: number | null
  /** Call off a pending start. The call itself is left alone. */
  cancelStart: () => void
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

/**
 * A provider and its key, or null when either is missing.
 *
 * Resolved once and carried for the session: a provider removed mid-meeting
 * is rarer than four keychain prompts per segment, and the recording survives
 * either way.
 */
async function credentialsFor<T extends AiProviderConfig>(
  config: T | null,
): Promise<{ config: T; apiKey: string } | null> {
  if (config === null) {
    return null
  }
  const apiKey = await aiApiKeyForConfig(config)
  return apiKey === null ? null : { config, apiKey }
}

/**
 * Grant screen-and-system-audio recording if it has not been granted.
 *
 * macOS prompts once ever per app, so a refusal here is permanent until the
 * user visits System Settings — which is why this asks rather than assuming,
 * and why a `false` is reported instead of recorded over.
 */
async function ensureSystemAudio(): Promise<boolean> {
  if (await systemAudioAccessGranted()) {
    return true
  }
  return await requestSystemAudioAccess()
}

export function MeetingRecordingProvider({
  graph,
  children,
}: MeetingRecordingProviderProps): ReactElement {
  const { settings } = useSettings()
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  })
  const [recording, setRecording] = useState(false)
  const [detectedAs, setDetectedAs] = useState<string | null>(null)
  const [startingAt, setStartingAt] = useState<number | null>(null)
  const [cancelledPid, setCancelledPid] = useState<number | null>(null)
  const pendingPidRef = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<MeetingSession | null>(null)
  // The process a hand-stopped recording was following, left alone until its
  // call actually ends.
  const [stoppedPid, setStoppedPid] = useState<number | null>(null)
  // The process the live recording is following, so the watcher knows which
  // call ending means this recording should stop.
  const [recordingPid, setRecordingPid] = useState<number | null>(null)
  const detectedPidRef = useRef<number | null>(null)
  // Read at start time: the detector sets it a tick before the session opens.
  const detectedAsRef = useRef<string | null>(null)
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
      setDetectedAs(null)
      detectedAsRef.current = null
      setRecordingPid(null)
      // Null for a manual recording, and that is right: nothing was detected,
      // so there is no call to leave alone. Guard anyway — a manual stop that
      // set `null` here would re-arm instantly on a detected session.
      setStoppedPid(detectedPidRef.current ?? recordingPid)
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
    const generation = generationRef.current
    const source = detectedAsRef.current
    // Ask before recording, never after. A tap created without this
    // permission is created happily and delivers digital silence, so a
    // recording that never asked is a recording of nothing.
    void ensureSystemAudio()
      .then(async (allowed) => {
        if (!allowed) {
          statusRef.current = 'idle'
          setRecording(false)
          setError('Reflect needs permission to record system audio.')
          return null
        }
        // Credentials are resolved once per session, not once per segment.
        // Each read is a keychain access, and macOS may ask the user to
        // approve it — four prompts per five minutes is not a feature.
        const settings = settingsRef.current
        const state = {
          providers: settings.aiProviders,
          defaultProviderId: settings.defaultAiProviderId,
        }
        const transcription = await credentialsFor(pickTranscriptionConfig(state))
        const assistant = await credentialsFor(
          settings.aiProviders.find((candidate) => candidate.id === settings.defaultAiProviderId) ??
            null,
        )

        return await startMeetingSession({
          segmentMs: MEETING_SEGMENT_MS,
          generation,
          ...(source === null ? {} : { source }),

          // Transcription and summarising are passed in rather than reached
          // for, so the session stays testable and a graph with no provider
          // configured still records — the audio is the durable part either
          // way.
          transcribeSegment:
            transcription === null
              ? undefined
              : async (_segment, audio) => {
                  if (audio.length === 0) {
                    return ''
                  }
                  return await transcribeAudio({
                    provider: transcription.config.provider,
                    apiKey: transcription.apiKey,
                    prompt: settings.transcriptionPrompt,
                    audio: new Blob([audio.slice().buffer], { type: 'audio/wav' }),
                    mimeType: 'audio/wav',
                    fetchFn: providerFetch,
                    isStale: () => false,
                  })
                },

          summarise:
            assistant === null
              ? undefined
              : async (segment, soFar) =>
                  await summariseMeetingSegment({
                    config: assistant.config,
                    apiKey: assistant.apiKey,
                    segment,
                    soFar: soFar.points,
                    decisionsSoFar: soFar.decisions,
                    tasksSoFar: soFar.tasks,
                    fetchFn: providerFetch,
                  }),

          // Named last, from what was said. Until then the note carries its
          // clock and its app, which is at least true.
          nameFromTranscript:
            assistant === null
              ? undefined
              : async (transcript) =>
                  await nameMeeting({
                    config: assistant.config,
                    apiKey: assistant.apiKey,
                    transcript,
                    fetchFn: providerFetch,
                  }),

          onSegment: (segment, path) => {
            console.debug('[meeting] segment imported', segment.part, segment.track, path)
          },
          onError: (message) => {
            console.debug('[meeting] segment import failed:', message)
            setError(message)
          },
        })
      })
      .then(
        (session) => {
          if (session === null) {
            return
          }
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

  // Only while nothing is recording: one person holds one conversation, so a
  // second candidate during a live session is a ringing app, not a meeting.
  // An excluded process is excluded until its call ends, not forever: the
  // next call from the same app is a different conversation, and a Slack that
  // stays silent for the rest of the session is a feature that broke.
  const excludedPid = stoppedPid ?? cancelledPid
  useCallWatch({
    enabled: !recording,
    ignorePid: excludedPid,
    onIgnoredEnded: () => {
      setStoppedPid(null)
      setCancelledPid(null)
    },
    onSettling: (candidate, until) => {
      pendingPidRef.current = candidate.pid
      setDetectedAs(candidateTitle(candidate))
      setStartingAt(until)
    },
    onSettlingEnded: () => {
      pendingPidRef.current = null
      setStartingAt(null)
      setDetectedAs(null)
      detectedAsRef.current = null
    },
    onCall: (candidate) => {
      setStartingAt(null)
      detectedPidRef.current = candidate.pid
      detectedAsRef.current = candidateTitle(candidate)
      setDetectedAs(detectedAsRef.current)
      setStoppedPid(null)
      setRecordingPid(candidate.pid)
      toggle()
    },
    recordingPid,
    // The call ended on its own, so the recording was never the user's to
    // stop — nothing to leave alone afterwards.
    onCallEnded: () => {
      detectedPidRef.current = null
      toggle()
    },
  })

  const cancelStart = useCallback((): void => {
    // Leave the call alone until it ends, rather than offering again in eight
    // seconds — someone who declined once meant it.
    setCancelledPid(pendingPidRef.current)
    pendingPidRef.current = null
    setStartingAt(null)
    setDetectedAs(null)
  }, [])

  return (
    <MeetingRecordingContext
      value={{ recording, detectedAs, startingAt, cancelStart, error, toggle }}
    >
      {children}
    </MeetingRecordingContext>
  )
}
