import { describe, expect, it } from 'vitest'
import type { CallCandidate } from '../recording/commands.ts'
import { candidateTitle, isCallCandidate, settledCandidate } from './call-detection.ts'

function candidate(overrides: Partial<CallCandidate>): CallCandidate {
  return { bundleId: 'x', pid: 1, app: 'Dia.app', windows: [], ...overrides }
}

describe('isCallCandidate', () => {
  it('trusts a native call app on the microphone alone', () => {
    expect(isCallCandidate(candidate({ app: 'Slack.app' }))).toBe(true)
    expect(isCallCandidate(candidate({ app: 'zoom.us.app' }))).toBe(true)
  })

  it('rejects the system daemon that holds the microphone forever', () => {
    // `historicalaudiod` reports an open microphone at all times, which is
    // why the app check is an allowlist and not a list of exceptions.
    expect(isCallCandidate(candidate({ app: 'historicalaudiod', bundleId: '' }))).toBe(false)
  })

  it('rejects a dictation app, which only ever captures', () => {
    expect(isCallCandidate(candidate({ app: 'Spokenly.app' }))).toBe(false)
  })

  it('needs a call window from a browser, which does everything', () => {
    expect(isCallCandidate(candidate({ windows: ['ChatGPT'] }))).toBe(false)
    expect(isCallCandidate(candidate({ windows: ['- ADIPA - Slack'] }))).toBe(true)
    expect(isCallCandidate(candidate({ windows: ['Meet – gzw-qodc-xps'] }))).toBe(true)
  })
})

describe('candidateTitle', () => {
  it('reads the person off a live huddle', () => {
    expect(candidateTitle(candidate({ windows: ['Felipe Villagrán - ADIPA - Slack'] }))).toBe(
      'Felipe Villagrán - ADIPA - Slack',
    )
  })

  it('declines to name a note after the pre-join dialog', () => {
    // `- ADIPA - Slack` is the dialog before anyone answers: the separator
    // sits where the name will go, so there is nothing to take and the
    // transcript names the note instead.
    expect(candidateTitle(candidate({ windows: ['- ADIPA - Slack'] }))).toBeNull()
  })
})

describe('settledCandidate', () => {
  const browser = candidate({ pid: 10, app: 'Dia.app', windows: ['- ADIPA - Slack'] })
  const native = candidate({ pid: 20, app: 'Slack.app' })

  it('picks the one that was still there after the wait', () => {
    // The desktop app rang and stopped; the browser carried the call.
    expect(settledCandidate([browser, native], [browser])?.pid).toBe(10)
  })

  it('picks nothing when every door closed', () => {
    expect(settledCandidate([browser], [])).toBeNull()
  })

  it('ignores a candidate that only appeared during the wait', () => {
    // It was not ringing when the countdown started, so it is a different
    // conversation beginning, not this one settling.
    expect(settledCandidate([browser], [native])).toBeNull()
  })
})
