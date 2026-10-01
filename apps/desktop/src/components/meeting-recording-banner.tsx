import type { ReactElement } from 'react'
import { Square } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { useMeetingRecording } from '@/providers/meeting-recording-provider.tsx'

/**
 * The only sign a meeting is being recorded.
 *
 * Detection starts a capture without being asked, so something has to say so
 * — a microphone that opened by itself and never announced it is the kind of
 * surprise that loses trust in a feature permanently. Stopping is one click
 * from here for the same reason.
 */
export function MeetingRecordingBanner(): ReactElement | null {
  const meeting = useMeetingRecording()
  if (!meeting.recording) {
    return null
  }
  return (
    <div className="mx-4 mt-2 flex items-center gap-2 rounded-md bg-red-500/10 px-2 py-1.5 text-xs">
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
    </div>
  )
}
