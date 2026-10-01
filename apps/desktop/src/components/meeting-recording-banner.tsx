import { useEffect, useState, type ReactElement } from 'react'
import { Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { useMeetingRecording } from '@/providers/meeting-recording-provider.tsx'

/**
 * The only sign a meeting is being recorded, and the only chance to say no.
 *
 * Detection starts a capture without being asked, so something has to say so
 * — a microphone that opened by itself and never announced it is the kind of
 * surprise that loses trust in a feature permanently. The countdown exists
 * for the same reason: the seconds the detector spends letting a ringing app
 * drop out are the seconds a person needs to decline.
 */
export function MeetingRecordingBanner(): ReactElement | null {
  const meeting = useMeetingRecording()
  const remaining = useCountdown(meeting.startingAt)

  if (meeting.startingAt !== null) {
    return (
      <Row tone="pending">
        <span className="min-w-0 flex-1 truncate text-text-secondary">
          Recording {meeting.detectedAs ?? 'this call'} in {remaining}…
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Do not record this call"
          onClick={() => meeting.cancelStart()}
        >
          <X className="size-3" />
        </Button>
      </Row>
    )
  }

  if (!meeting.recording) {
    return null
  }
  return (
    <Row tone="live">
      <span aria-hidden className="size-2 flex-none animate-pulse rounded-full bg-red-500" />
      <span className="min-w-0 flex-1 truncate text-text-secondary">
        {meeting.detectedAs ?? 'Recording meeting'}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Stop recording the meeting"
        onClick={() => meeting.toggle()}
      >
        <Square className="size-3" fill="currentColor" />
      </Button>
    </Row>
  )
}

function Row({
  tone,
  children,
}: {
  tone: 'pending' | 'live'
  children: React.ReactNode
}): ReactElement {
  return (
    <div
      className={`mx-4 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
        tone === 'live' ? 'bg-red-500/10' : 'bg-text-muted/10'
      }`}
    >
      {children}
    </div>
  )
}

/** Seconds left, ticking, so the countdown reads as one. */
function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [until])
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}
