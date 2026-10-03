import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { deleteAudioMemo, importAudioMemo, readAsset } from '../graph/commands.ts'
import { hasBinaryIpc } from '../ipc/bridge.ts'
import {
  startMeetingRecording,
  stopMeetingRecording,
  subscribeRecordingSegments,
  traceRecording,
  type RecordingSegment,
} from '../recording/commands.ts'
import {
  appendDecision,
  appendSummary,
  appendTask,
  appendTranscript,
  discardMeetingNote,
  openMeetingNote,
  renameMeetingNote,
} from './meeting-note.ts'
import { startMeetingSession, type StartMeetingSessionInput } from './meeting-recording.ts'

vi.mock('../graph/commands', () => ({
  deleteAudioMemo: vi.fn(),
  importAudioMemo: vi.fn(),
  readAsset: vi.fn(),
  readAssetBinary: vi.fn(),
}))
vi.mock('../ipc/bridge', () => ({
  hasBinaryIpc: vi.fn(),
}))
vi.mock('../recording/commands', () => ({
  startMeetingRecording: vi.fn(),
  stopMeetingRecording: vi.fn(),
  subscribeRecordingSegments: vi.fn(),
  traceRecording: vi.fn(),
}))
vi.mock('./meeting-note', () => ({
  appendDecision: vi.fn(),
  appendSummary: vi.fn(),
  appendTask: vi.fn(),
  appendTranscript: vi.fn(),
  discardMeetingNote: vi.fn(),
  openMeetingNote: vi.fn(),
  renameMeetingNote: vi.fn(),
}))

const GENERATION = 4

/** Loud enough to count as somebody being there. */
const HEARD = 50_000

function segment(overrides: Partial<RecordingSegment> = {}): RecordingSegment {
  return {
    part: 0,
    end: false,
    track: 'system',
    path: '/tmp/staging/part-000.system.wav',
    frames: 80_000,
    loud: 0,
    rate: 16_000,
    ...overrides,
  }
}

/** Both sides of one rotation, which is what the capture actually announces. */
function rotation(
  part: number,
  options: { loud?: number; end?: boolean } = {},
): RecordingSegment[] {
  return [
    segment({ part, track: 'system', loud: options.loud ?? HEARD, end: options.end ?? false }),
    segment({ part, track: 'mic', loud: HEARD, end: options.end ?? false }),
  ]
}

/** Let every chained import/transcribe/summarise microtask run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

let announce: (segment: RecordingSegment) => void
let unlisten: Mock<() => void>

beforeEach(() => {
  vi.clearAllMocks()
  unlisten = vi.fn<() => void>()
  announce = () => {}
  vi.mocked(subscribeRecordingSegments).mockImplementation(async (handler) => {
    announce = handler
    return await Promise.resolve(unlisten)
  })
  vi.mocked(importAudioMemo).mockResolvedValue(undefined)
  vi.mocked(deleteAudioMemo).mockResolvedValue(undefined)
  vi.mocked(openMeetingNote).mockResolvedValue('notes/x.md')
  vi.mocked(hasBinaryIpc).mockReturnValue(false)
  vi.mocked(readAsset).mockResolvedValue('')
  // The capture closes each track *after* being told to stop, which is what
  // makes the end-marked segments arrive late.
  vi.mocked(stopMeetingRecording).mockImplementation(async () => {
    for (const part of rotation(99, { loud: 0, end: true })) {
      announce(part)
    }
    await Promise.resolve()
  })
})

function start(overrides: Partial<StartMeetingSessionInput> = {}) {
  return startMeetingSession({
    segmentMs: 300_000,
    generation: GENERATION,
    source: 'Slack',
    ...overrides,
  })
}

describe('startMeetingSession', () => {
  it('subscribes before it starts, so no segment can slip between them', async () => {
    await start()

    const subscribed = vi.mocked(subscribeRecordingSegments).mock.invocationCallOrder[0] ?? 0
    const started = vi.mocked(startMeetingRecording).mock.invocationCallOrder[0] ?? 0
    expect(subscribed).toBeLessThan(started)
    expect(startMeetingRecording).toHaveBeenCalledWith(300_000)
  })

  it('opens the note named for the clock and the app', async () => {
    await start()

    expect(openMeetingNote).toHaveBeenCalledWith(
      expect.objectContaining({ base: expect.stringContaining('audio-memo-') }),
      expect.stringMatching(/^\d\d:\d\d · Slack$/u),
      GENERATION,
    )
  })

  it('names an undetected meeting without inventing an app', async () => {
    await start({ source: undefined })

    expect(openMeetingNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^\d\d:\d\d · Reunión$/u),
      GENERATION,
    )
  })

  it('releases the subscription when the capture refuses to start', async () => {
    vi.mocked(startMeetingRecording).mockRejectedValueOnce(new Error('no permission'))

    await expect(start()).rejects.toThrow('no permission')
    expect(unlisten).toHaveBeenCalled()
  })
})

describe('segments', () => {
  it('imports each track under its own name', async () => {
    await start()
    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()

    expect(importAudioMemo).toHaveBeenCalledWith(
      '/tmp/staging/part-000.system.wav',
      expect.stringMatching(/\.part-000\.system\.wav$/u),
      GENERATION,
    )
    expect(importAudioMemo).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/\.part-000\.mic\.wav$/u),
      GENERATION,
    )
  })

  it('reports an import failure and keeps recording', async () => {
    const onError = vi.fn()
    vi.mocked(importAudioMemo).mockRejectedValueOnce(new Error('disk full'))
    await start({ onError })

    announce(segment({ part: 0, track: 'system' }))
    announce(segment({ part: 0, track: 'mic', loud: HEARD }))
    await settle()

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    expect(importAudioMemo).toHaveBeenCalledTimes(2)
  })

  it('appends each side of the transcript as it lands', async () => {
    const transcribeSegment = vi
      .fn<NonNullable<StartMeetingSessionInput['transcribeSegment']>>()
      .mockImplementation(
        async (part) =>
          await Promise.resolve(part.track === 'system' ? '¿Cuántos colegios?' : 'Tres'),
      )
    await start({ transcribeSegment })

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()

    expect(appendTranscript).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ track: 'system', text: '¿Cuántos colegios?' }),
      GENERATION,
    )
    expect(appendTranscript).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ track: 'mic', text: 'Tres' }),
      GENERATION,
    )
  })

  it('records without a provider, because the audio is the durable part', async () => {
    await start({ transcribeSegment: undefined })
    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()

    expect(importAudioMemo).toHaveBeenCalledTimes(2)
    expect(appendTranscript).not.toHaveBeenCalled()
  })

  it('survives a transcription that fails', async () => {
    const transcribeSegment = vi.fn().mockRejectedValue(new Error('429'))
    await start({ transcribeSegment })

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()

    expect(appendTranscript).not.toHaveBeenCalled()
    expect(traceRecording).toHaveBeenCalledWith(expect.stringContaining('TRANSCRIBE FAILED'))
  })
})

describe('summarising', () => {
  const transcribeSegment = async (part: RecordingSegment): Promise<string> =>
    await Promise.resolve(part.track === 'system' ? 'ellos' : 'yo')

  it('waits for both sides of a rotation, so it never summarises half a conversation', async () => {
    const summarise = vi.fn().mockResolvedValue({ points: [], decisions: [], tasks: [] })
    await start({ transcribeSegment, summarise })

    announce(segment({ part: 0, track: 'system', loud: HEARD }))
    await settle()
    expect(summarise).not.toHaveBeenCalled()

    announce(segment({ part: 0, track: 'mic', loud: HEARD }))
    await settle()
    expect(summarise).toHaveBeenCalledTimes(1)
    expect(summarise).toHaveBeenCalledWith('Them: ellos\n\nYou: yo', {
      points: [],
      decisions: [],
      tasks: [],
    })
  })

  it('writes each kind of line into the note', async () => {
    const summarise = vi.fn().mockResolvedValue({
      points: ['Hablaron de precios'],
      decisions: ['Partimos en agosto'],
      tasks: ['Martín: enviar precios'],
    })
    await start({ transcribeSegment, summarise })

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()

    expect(appendSummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: 'Hablaron de precios' }),
      GENERATION,
    )
    expect(appendDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: 'Partimos en agosto' }),
      GENERATION,
    )
    expect(appendTask).toHaveBeenCalledWith(expect.anything(), 'Martín: enviar precios', GENERATION)
  })

  it('hands back what is already noted, so the next pass does not repeat it', async () => {
    const summarise = vi
      .fn()
      .mockResolvedValueOnce({ points: ['p1'], decisions: ['d1'], tasks: ['t1'] })
      .mockResolvedValue({ points: [], decisions: [], tasks: [] })
    await start({ transcribeSegment, summarise })

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()
    for (const part of rotation(1)) {
      announce(part)
    }
    await settle()

    expect(summarise).toHaveBeenNthCalledWith(2, expect.any(String), {
      points: ['p1'],
      decisions: ['d1'],
      tasks: ['t1'],
    })
  })
})

describe('stop', () => {
  it('discards a session nobody else was heard in', async () => {
    const onDiscarded = vi.fn()
    const session = await start({ onDiscarded })

    for (const part of rotation(0, { loud: 0 })) {
      announce(part)
    }
    await settle()
    await session.stop()

    expect(deleteAudioMemo).toHaveBeenCalledTimes(4)
    expect(discardMeetingNote).toHaveBeenCalledWith(session.memo, GENERATION)
    expect(onDiscarded).toHaveBeenCalled()
    expect(renameMeetingNote).not.toHaveBeenCalled()
  })

  it('keeps a session the far end spoke in', async () => {
    const session = await start()

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()
    await session.stop()

    expect(discardMeetingNote).not.toHaveBeenCalled()
    expect(deleteAudioMemo).not.toHaveBeenCalled()
  })

  it('renames the note from what was said', async () => {
    const session = await start({
      transcribeSegment: async (part) =>
        await Promise.resolve(part.track === 'system' ? 'ellos' : 'yo'),
      summarise: async () => await Promise.resolve({ points: [], decisions: [], tasks: [] }),
      nameFromTranscript: async () => await Promise.resolve('Precios por colegio'),
    })

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()
    await session.stop()

    expect(renameMeetingNote).toHaveBeenCalledWith(
      session.memo,
      expect.stringMatching(/^\d\d:\d\d · Slack · Precios por colegio$/u),
      GENERATION,
    )
  })

  it('keeps the opening name when naming fails', async () => {
    const session = await start({
      transcribeSegment: async () => await Promise.resolve('algo'),
      summarise: async () => await Promise.resolve({ points: [], decisions: [], tasks: [] }),
      nameFromTranscript: async () => await Promise.reject(new Error('timeout')),
    })

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()
    await expect(session.stop()).resolves.toBeUndefined()

    expect(renameMeetingNote).not.toHaveBeenCalled()
  })

  it('does not wait on a transcription, so the next meeting can start at once', async () => {
    // The whole point of decoupling capture from processing: an hour-long
    // meeting still being transcribed must not hold the next one hostage.
    const session = await start({
      transcribeSegment: async () => await new Promise<string>(() => {}),
    })

    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()

    await expect(session.stop()).resolves.toBeUndefined()
    expect(unlisten).toHaveBeenCalled()
  })

  it('is safe to call twice', async () => {
    const session = await start()
    for (const part of rotation(0)) {
      announce(part)
    }
    await settle()

    await session.stop()
    await session.stop()

    expect(stopMeetingRecording).toHaveBeenCalledTimes(1)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})

describe('stop after a failed import', () => {
  it('still judges the session, rather than dying with the failed copy', async () => {
    // A disk that filled on the last segment must not cost the discard check:
    // skipping it is how an empty note survives a call nobody answered.
    vi.mocked(importAudioMemo).mockRejectedValue(new Error('disk full'))
    const onDiscarded = vi.fn()
    const session = await start({ onDiscarded, onError: vi.fn() })

    for (const part of rotation(0, { loud: 0 })) {
      announce(part)
    }
    await settle()

    await expect(session.stop()).resolves.toBeUndefined()
    expect(discardMeetingNote).toHaveBeenCalled()
    expect(onDiscarded).toHaveBeenCalled()
  })
})
