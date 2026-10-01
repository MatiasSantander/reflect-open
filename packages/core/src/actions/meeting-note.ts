import { deleteNote, readNote, writeNote } from '../graph/commands.ts'
import { isAppError } from '../errors.ts'
import { dailyPath, notePath } from '../graph/paths.ts'
import {
  appendListItemUnderBacklinkedHeading,
  appendListItemUnderHeading,
  wikiLinkSafe,
} from '../markdown/edit.ts'
import type { AudioMemoIdentity, AudioMemoTrack } from './audio-memo.ts'
import { trackLabel } from './audio-memo-session.ts'

/**
 * The meeting note, written while the meeting is still happening (Plan 25).
 *
 * This is the one place the feature departs from audio memos, and the reason
 * is the whole point of it: a memo's note is assembled once the recording is
 * over, but a meeting note has to exist from the first second so the user can
 * type their own notes into it *during* the call. Everything else — the
 * capture, the import, the transcription — stays shared.
 *
 * Because the note exists early, the audio-memo reconcile pass will skip the
 * session (it only adopts sessions with no note yet), so transcription for a
 * meeting is driven from here, segment by segment, as they land.
 */

/** Where the running summary accumulates. */
const SUMMARY_HEADING = 'Puntos clave'

/** Where what was actually settled goes, separate from what was discussed. */
const DECISIONS_HEADING = 'Decisiones'

/** Where each segment's transcript lands. */
const TRANSCRIPT_HEADING = 'Transcript'

/** Where commitments made out loud become checkboxes. */
const TASKS_HEADING = 'Tareas'

/** The heading a day's meetings are backlinked under. */
export const MEETINGS_NOTE_TITLE = 'Meetings'

/**
 * Create the note a meeting is about to fill.
 *
 * The body is deliberately sparse: a title, the two section headings, and
 * nothing between the title and `## Resumen` — that gap is where the user
 * writes, and it is left empty rather than seeded so the first thing they see
 * is their own cursor and not a template to delete.
 */
export async function openMeetingNote(
  memo: AudioMemoIdentity,
  title: string,
  generation: number,
): Promise<string> {
  const path = notePath(memo.base)
  const body = [
    `---`,
    `aliases: [${memo.base}]`,
    `---`,
    ``,
    `# ${title}`,
    ``,
    ``,
    `## ${SUMMARY_HEADING}`,
    ``,
    `## ${DECISIONS_HEADING}`,
    ``,
    `## ${TASKS_HEADING}`,
    ``,
    `## ${TRANSCRIPT_HEADING}`,
    ``,
  ].join('\n')
  await writeNote(path, body, generation)
  await backlinkFromDaily(memo, title, generation)
  return path
}

/** Link the meeting from its day, the way audio memos link theirs. */
async function backlinkFromDaily(
  memo: AudioMemoIdentity,
  title: string,
  generation: number,
): Promise<void> {
  const source = await noteSource(dailyPath(memo.date), generation)
  const entry = `[[${memo.base}|${wikiLinkSafe(title) || memo.title}]]`
  if (source.includes(`[[${memo.base}`)) {
    return
  }
  const updated = appendListItemUnderBacklinkedHeading(source, MEETINGS_NOTE_TITLE, entry, [
    MEETINGS_NOTE_TITLE,
  ])
  await writeNote(dailyPath(memo.date), updated, generation)
}

/**
 * Append one segment's transcript, labelled by track and by the time it was
 * said rather than by position — a reader looking for "what did they say
 * around 17:20" is the only reader a transcript ever has.
 */
export async function appendTranscript(
  memo: AudioMemoIdentity,
  entry: { track: AudioMemoTrack | null; at: Date; text: string },
  generation: number,
): Promise<void> {
  const text = entry.text.trim()
  if (text === '') {
    return
  }
  const label = trackLabel(entry.track)
  const stamp = clockOf(entry.at)
  const line = label === null ? `**${stamp}** — ${text}` : `**${stamp} · ${label}** — ${text}`
  await appendUnder(memo, TRANSCRIPT_HEADING, line, generation)
}

/** Append one decision. Settled things only — the discussion is above. */
export async function appendDecision(
  memo: AudioMemoIdentity,
  entry: { at: Date; text: string },
  generation: number,
): Promise<void> {
  const text = entry.text.trim()
  if (text === '') {
    return
  }
  await appendUnder(memo, DECISIONS_HEADING, `**${clockOf(entry.at)}** ${text}`, generation)
}

/** Append one bullet to the running summary. */
export async function appendSummary(
  memo: AudioMemoIdentity,
  entry: { at: Date; text: string },
  generation: number,
): Promise<void> {
  const text = entry.text.trim()
  if (text === '') {
    return
  }
  await appendUnder(memo, SUMMARY_HEADING, `**${clockOf(entry.at)}** ${text}`, generation)
}

/**
 * Append one task as an unticked checkbox — ordinary markdown, so it is a
 * task everywhere in the app and not a thing this feature invented.
 */
export async function appendTask(
  memo: AudioMemoIdentity,
  text: string,
  generation: number,
): Promise<void> {
  const task = text.trim()
  if (task === '') {
    return
  }
  await appendUnder(memo, TASKS_HEADING, `[ ] ${task}`, generation)
}

/**
 * Rename the note once the meeting is over and there is something to name it
 * after.
 *
 * A meeting opens named for its clock and its app, because that is all that
 * is known in the first second. What it was *about* only exists afterwards,
 * and a day of `Personal: Meet - Follow-…` repeated eight times is a day
 * nobody can read — the window title names the window, not the conversation.
 *
 * The file keeps its path: identity is the frontmatter alias, so renaming is
 * a heading and a link label, and every backlink survives.
 */
export async function renameMeetingNote(
  memo: AudioMemoIdentity,
  title: string,
  generation: number,
): Promise<void> {
  const next = title.trim()
  if (next === '') {
    return
  }
  const path = notePath(memo.base)
  const source = await noteSource(path, generation)
  if (source === '') {
    return
  }
  const renamed = source.replace(/^# .*$/mu, `# ${next}`)
  if (renamed !== source) {
    await writeNote(path, renamed, generation)
  }
  const daily = await noteSource(dailyPath(memo.date), generation)
  const entry = new RegExp(String.raw`\[\[${memo.base}(\|[^\]]*)?\]\]`, 'u')
  if (entry.test(daily)) {
    await writeNote(
      dailyPath(memo.date),
      daily.replace(entry, `[[${memo.base}|${wikiLinkSafe(next) || next}]]`),
      generation,
    )
  }
}

/**
 * Take a meeting note back out: the note itself and the line that links it
 * from its day.
 *
 * Discarding only the audio would leave the shape of a meeting behind — an
 * empty note and a daily-note entry pointing at nothing — which is worse
 * than the recording it was trying to undo.
 */
export async function discardMeetingNote(
  memo: AudioMemoIdentity,
  generation: number,
): Promise<void> {
  const daily = await noteSource(dailyPath(memo.date), generation)
  if (daily !== '') {
    const withoutEntry = daily
      .split('\n')
      .filter((line) => !line.includes(`[[${memo.base}`))
      .join('\n')
    if (withoutEntry !== daily) {
      await writeNote(dailyPath(memo.date), withoutEntry, generation)
    }
  }
  await deleteNote(notePath(memo.base), generation)
}

function clockOf(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Append under a heading, re-reading the note first.
 *
 * Always a fresh read: the user is typing in this note while the append
 * happens, so a cached copy would be stale by exactly the words they just
 * wrote.
 */
async function appendUnder(
  memo: AudioMemoIdentity,
  heading: string,
  line: string,
  generation: number,
): Promise<void> {
  const path = notePath(memo.base)
  const source = await noteSource(path, generation)
  if (source === '') {
    // The note was deleted mid-meeting. That is a decision, not a glitch:
    // recreating it would overwrite the user's choice.
    return
  }
  await writeNote(path, appendListItemUnderHeading(source, heading, line), generation)
}

async function noteSource(path: string, generation: number): Promise<string> {
  try {
    return await readNote(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}
