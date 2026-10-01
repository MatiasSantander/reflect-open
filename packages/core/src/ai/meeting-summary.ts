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
  points: z.array(z.string()).max(4),
  /**
   * Only what someone actually committed to. A task invented from "we should
   * probably look at that" is worse than no task at all: it earns a checkbox
   * that will never be ticked and teaches the user to stop reading the list.
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
  fetchFn?: typeof fetch | undefined
}

function summaryPrompt(request: MeetingSummaryRequest): string {
  const previously =
    request.soFar.length === 0
      ? 'Nothing has been noted yet.'
      : `Already noted, do not repeat:\n${request.soFar.map((point) => `- ${point}`).join('\n')}`
  return [
    'You are keeping notes during a live meeting.',
    'Below is the last few minutes of transcript. Return two things, both in',
    'the language the meeting is in:',
    '',
    '- points: what someone who missed it would need — decisions, numbers,',
    '  and what was left open.',
    '- tasks: only things a person committed to doing. Someone saying they',
    '  will send, check, or confirm something is a task. "We should look at',
    '  that some day" is not. Name who, when the transcript says.',
    '',
    'Return empty lists if this stretch held neither — small talk, silence,',
    'and thinking out loud are not worth a line.',
    '',
    previously,
    '',
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
  tasks: string[]
}

export async function summariseMeetingSegment(
  request: MeetingSummaryRequest,
): Promise<MeetingSummary> {
  if (request.segment.trim() === '') {
    return { points: [], tasks: [] }
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
    return { points: clean(result.output.points), tasks: clean(result.output.tasks) }
  } catch {
    // The transcript is already in the note; a missing summary line is a
    // smaller loss than a thrown error that takes the segment with it.
    return { points: [], tasks: [] }
  }
}
