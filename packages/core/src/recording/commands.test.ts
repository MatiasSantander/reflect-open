import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import {
  callCandidates,
  startMeetingRecording,
  stopMeetingRecording,
  subscribeRecordingSegments,
  traceRecording,
} from './commands.ts'

afterEach(() => setBridge(null))

/**
 * The contracts across the recording bridge.
 *
 * `stop` is the one that earns a test of its own: a Rust command returning
 * `()` arrives as JSON `null`, and a schema that rejects it turns every stop
 * into a rejection — the capture halts, because Rust already acted, while
 * every decision that hangs off the stop silently never runs.
 */
describe('recording IPC contracts', () => {
  it('accepts the null a command with no answer returns', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    setBridge({ invoke, listen: async () => () => {} })

    await expect(stopMeetingRecording()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('recording_stop', {})
  })

  it('swallows a failed trace, because a log line must never disturb a recording', async () => {
    setBridge({ invoke: async () => ({ unexpected: true }), listen: async () => () => {} })

    await expect(traceRecording('hello')).resolves.toBeUndefined()
  })

  it('accepts a segment the capture announces', async () => {
    let announced: unknown
    setBridge({
      invoke: async () => null,
      listen: async (_event, handler) => {
        announced = handler
        return () => {}
      },
    })
    const seen: unknown[] = []
    await subscribeRecordingSegments((segment) => {
      seen.push(segment)
    })
    ;(announced as (payload: unknown) => void)({
      part: 1,
      end: true,
      track: 'system',
      path: '/tmp/part-001.system.wav',
      frames: 574_635,
      loud: 0,
      rate: 16_000,
    })

    expect(seen).toEqual([
      {
        part: 1,
        end: true,
        track: 'system',
        path: '/tmp/part-001.system.wav',
        frames: 574_635,
        loud: 0,
        rate: 16_000,
      },
    ])
  })

  it('rejects a start whose answer does not match', async () => {
    setBridge({ invoke: async () => ({ stagingDir: 7 }), listen: async () => () => {} })

    await expect(startMeetingRecording(300_000)).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reads the candidates Rust offers', async () => {
    setBridge({
      invoke: async () => [
        {
          bundleId: 'com.tinyspeck.slackmacgap',
          pid: 123,
          app: 'Slack',
          windows: ['Matías - Slack'],
        },
      ],
      listen: async () => () => {},
    })

    await expect(callCandidates()).resolves.toEqual([
      {
        bundleId: 'com.tinyspeck.slackmacgap',
        pid: 123,
        app: 'Slack',
        windows: ['Matías - Slack'],
      },
    ])
  })
})
