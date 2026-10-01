import { z } from 'zod'
import type { AiProviderConfig } from '../settings/schema.ts'
import { languageModel } from './language-model.ts'

/**
 * The running summary of a meeting: the key points of each closed segment,
 * added while the meeting is still going (Plan 25).
 *
 * Deliberately small. The model sees one segment plus the points already
 * written, never the whole transcript, which keeps the cost flat however long
 * the meeting runs and stops it restating what the note already says.
 */

/** A segment's summary is a few lines or nothing — silence earns silence. */
const summarySchema = z.object({
  /** What someone who missed this stretch would need to know. */
  points: z.array(z.string()).max(4),
  /** Only what was actually settled, not what was discussed. */
  decisions: z.array(z.string()).max(3),
  /**
   * Only what someone committed to doing, and only when it is clear who.
   * A task hedged with "someone will" or "the owner is unclear" is worse
   * than no task: it earns a checkbox nobody ticks and teaches the reader
   * to stop reading the list.
   */
  tasks: z.array(z.string()).max(4),
})

/**
 * A summary pass is best-effort and must never delay the next segment, so it
 * is given less time than a segment takes to record.
 */
const SUMMARY_TIMEOUT_MS = 60_000

export interface MeetingSummaryRequest {
  config: AiProviderConfig
  apiKey: string
  /** What was said in the segment just closed, both sides. */
  segment: string
  /** Points already in the note, so the model does not repeat them. */
  soFar: readonly string[]
  /** Decisions already in the note. */
  decisionsSoFar: readonly string[]
  /**
   * Tasks already in the note. Without these the same commitment is written
   * once per segment in slightly different words, which is how a list of
   * four real tasks becomes eleven near-duplicates.
   */
  tasksSoFar: readonly string[]
  fetchFn?: typeof fetch | undefined
}

function alreadyNoted(label: string, lines: readonly string[]): string {
  return lines.length === 0
    ? ''
    : `${label} already noted:\n${lines.map((line) => `- ${line}`).join('\n')}\n`
}

function summaryPrompt(request: MeetingSummaryRequest): string {
  return [
    'You are keeping notes during a live meeting. Below is the last few',
    'minutes of transcript. Write in the language the meeting is in.',
    '',
    'Return three lists, and prefer returning nothing to returning filler:',
    '',
    'points — what someone who missed these minutes needs to know. Facts,',
    '  numbers, positions taken, problems raised. Not a retelling: if a line',
    '  could be dropped without losing information, drop it.',
    '',
    'decisions — only what was settled. "We will go with three colegios" is a',
    '  decision; "we talked about how many colegios" is not.',
    '',
    'tasks — only commitments with a clear owner, phrased as an imperative',
    '  starting with the name: "Martín: enviar el detalle de precios".',
    '  **If you cannot tell who committed, leave the task out entirely.**',
    '  Never write that the owner is unclear, unidentified, or uncertain —',
    '  a task nobody owns is not a task. One line each, no explanation.',
    '',
    'Nothing here repeats what is already noted below. If this stretch only',
    'added detail to something already written, return empty lists.',
    '',
    alreadyNoted('Points', request.soFar),
    alreadyNoted('Decisions', request.decisionsSoFar),
    alreadyNoted('Tasks', request.tasksSoFar),
    'Transcript:',
    request.segment,
  ].join('\n')
}

/**
 * Summarise one segment. Empty on failure or on a stretch with nothing in it
 * — a meeting note that stays quiet about a quiet five minutes is correct,
 * not broken.
 */
export interface MeetingSummary {
  points: string[]
  decisions: string[]
  tasks: string[]
}

export async function summariseMeetingSegment(
  request: MeetingSummaryRequest,
): Promise<MeetingSummary> {
  if (request.segment.trim() === '') {
    return { points: [], decisions: [], tasks: [] }
  }
  try {
    const { generateText, Output } = await import('@reflect/modules/ai')
    const result = await generateText({
      model: await languageModel(request.config, request.apiKey, request.fetchFn ?? fetch),
      output: Output.object({ schema: summarySchema }),
      prompt: summaryPrompt(request),
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      maxRetries: 0,
    })
    const clean = (lines: string[]): string[] =>
      lines.map((line) => line.trim()).filter((line) => line !== '')
    return {
      points: clean(result.output.points),
      decisions: clean(result.output.decisions),
      tasks: clean(result.output.tasks).filter(hasAnOwner),
    }
  } catch {
    // The transcript is already in the note; a missing summary line is a
    // smaller loss than a thrown error that takes the segment with it.
    return { points: [], decisions: [], tasks: [] }
  }
}

/**
 * Drop a task the model hedged anyway. The prompt asks it not to, and it
 * mostly obeys, but "responsable no identificado" surviving into a checkbox
 * is the failure that makes a whole list ignorable — so it is checked twice.
 */
function hasAnOwner(task: string): boolean {
  return !/no identificad|sin identificar|no queda confirmado|unclear|unidentified|not confirmed|alguien|someone/iu.test(
    task,
  )
}

/**
 * Name a meeting from what was said in it.
 *
 * Short on purpose: the note's name already carries the clock and the app,
 * and this is the third part — the topic. "Ajustes de la landing", not "
 * Reunión sobre los ajustes pendientes de la landing page".
 */
export async function nameMeeting(request: {
  config: AiProviderConfig
  apiKey: string
  transcript: string
  fetchFn?: typeof fetch | undefined
}): Promise<string> {
  if (request.transcript.trim() === '') {
    return ''
  }
  try {
    const { generateText, Output } = await import('@reflect/modules/ai')
    const result = await generateText({
      model: await languageModel(request.config, request.apiKey, request.fetchFn ?? fetch),
      output: Output.object({ schema: z.object({ topic: z.string() }) }),
      prompt: [
        'Below is a meeting transcript. Name what it was about in at most six',
        'words, in the language of the meeting. No date, no "reunión", no',
        'punctuation at the end — just the subject, as a colleague would say',
        'it when asked what the call was about.',
        '',
        request.transcript.slice(0, 20_000),
      ].join('\n'),
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      maxRetries: 0,
    })
    return result.output.topic.trim().replaceAll(/[.·|[\]]/gu, '')
  } catch {
    // The note keeps the name it opened with, which is still a real name.
    return ''
  }
}
