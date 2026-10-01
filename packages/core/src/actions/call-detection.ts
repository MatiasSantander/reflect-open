import type { CallCandidate } from '../recording/commands.ts'

/**
 * Deciding whether an open microphone means a call (Plan 25, contract 3).
 *
 * Rust reports which processes hold the microphone and what their app's
 * windows are called; everything here is the judgement on top. It lives in
 * core, and not in the capture, because these lists are the part that rots:
 * Slack will change its window titles long before Core Audio changes its
 * property selectors.
 */

/**
 * Apps that only ever open the microphone for a call, so the microphone alone
 * settles it. A system daemon like `historicalaudiod` holds the microphone
 * permanently and is excluded by not being here, which is why the list is an
 * allowlist rather than a set of exceptions.
 */
export const CALL_APPS: readonly string[] = [
  'Slack.app',
  'zoom.us.app',
  'Microsoft Teams.app',
  'Discord.app',
  'FaceTime.app',
]

/** Apps that do everything, so an open microphone proves nothing on its own. */
export const BROWSER_APPS: readonly string[] = [
  'Dia.app',
  'Google Chrome.app',
  'Safari.app',
  'Firefox.app',
  'Arc.app',
  'Microsoft Edge.app',
  'Brave Browser.app',
]

/**
 * What a call window is called. Matched case-insensitively against every
 * window of a browser, because a huddle opens as its own window beside the
 * tabs — the observed title is `- ADIPA - Slack`, which carries the workspace
 * and, once someone answers, the person on the other end.
 */
export const CALL_WINDOW_PATTERNS: readonly string[] = [
  '- slack',
  'meet.google.com',
  'meet –',
  'meet -',
  'zoom',
  'teams',
]

/** The candidate's window that looks like a call, if any. */
export function callWindow(candidate: CallCandidate): string | null {
  return (
    candidate.windows.find((title) => {
      const folded = title.toLowerCase()
      return CALL_WINDOW_PATTERNS.some((pattern) => folded.includes(pattern))
    }) ?? null
  )
}

/**
 * Is this open microphone a call?
 *
 * Deliberately loose. A browser playing a voice assistant with a Slack window
 * open elsewhere passes, and that is accepted: the countdown is cancelable,
 * and a session nobody else spoke in is discarded before it costs anything.
 * Tightening this — demanding the matching window be frontmost — is the
 * refinement to reach for only if the false positives actually appear.
 */
export function isCallCandidate(candidate: CallCandidate): boolean {
  if (CALL_APPS.includes(candidate.app)) {
    return true
  }
  return BROWSER_APPS.includes(candidate.app) && callWindow(candidate) !== null
}

/**
 * What to call the note, from the window that matched. `- ADIPA - Slack` is
 * the pre-join dialog and carries no name yet, so a title that starts with
 * the separator is worth nothing and the transcript gets to name the note
 * instead — which it already does for audio memos.
 */
export function candidateTitle(candidate: CallCandidate): string | null {
  const window = callWindow(candidate)
  if (window === null) {
    return null
  }
  // `- ADIPA - Slack` is the dialog before anyone answers: the separator sits
  // where the person's name will go, so there is no name to take and the
  // transcript supplies one instead, as it already does for audio memos.
  if (/^[\s–—-]/u.test(window)) {
    return null
  }
  const trimmed = window.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Which candidate to record once the situation has settled.
 *
 * One Slack call rings in the desktop app *and* the browser, so the first
 * candidate to appear may be the one merely ringing — attaching to it records
 * a ringtone and then silence. Waiting lets the extra doors close, and the
 * survivor is the call someone actually answered.
 *
 * Identity is the pid: an app can close one call window and open the next
 * without its process changing, and that is a new conversation, not this one
 * continuing.
 */
export function settledCandidate(
  seen: readonly CallCandidate[],
  now: readonly CallCandidate[],
): CallCandidate | null {
  // Several survivors would mean two apps genuinely holding a call open at
  // once; one person holds one conversation, so the first is as good a choice
  // as any and there is nothing to weigh.
  return (
    now.find(
      (candidate) =>
        isCallCandidate(candidate) && seen.some((earlier) => earlier.pid === candidate.pid),
    ) ?? null
  )
}
