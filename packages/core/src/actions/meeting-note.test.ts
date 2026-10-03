import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteNote, readNote, writeNote } from '../graph/commands.ts'
import { dailyPath, notePath } from '../graph/paths.ts'
import type { AudioMemoIdentity } from './audio-memo.ts'
import {
  appendDecision,
  appendSummary,
  appendTask,
  appendTranscript,
  discardMeetingNote,
  openMeetingNote,
  renameMeetingNote,
} from './meeting-note.ts'

vi.mock('../graph/commands', () => ({
  deleteNote: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))

const GENERATION = 7
const BASE = 'audio-memo-2026-07-01-110600-123'
const MAIN = notePath(BASE)
const TRANSCRIPT = notePath(`${BASE}-transcript`)
const DAILY = dailyPath('2026-07-01')

const memo: AudioMemoIdentity = {
  base: BASE,
  date: '2026-07-01',
  title: 'Audio memo 11:06',
  alias: 'Audio memo 11:06',
  audioPath: `audio-memos/${BASE}.wav`,
  notePath: MAIN,
  mimeType: 'audio/wav',
}

/**
 * A graph that remembers what was written to it.
 *
 * The interesting behaviour here is all in the markdown — which heading a line
 * lands under, which link label goes stale on a rename — so the notes have to
 * be real text that the next call reads back, not a list of mock arguments.
 */
let files: Map<string, string>

beforeEach(() => {
  files = new Map([[DAILY, '# Tuesday\n']])
  vi.mocked(readNote).mockImplementation(async (path: string) => {
    const source = files.get(path)
    if (source === undefined) {
      throw { kind: 'notFound', message: `no such note: ${path}` }
    }
    return await Promise.resolve(source)
  })
  vi.mocked(writeNote).mockImplementation(async (path: string, source: string) => {
    files.set(path, source)
    await Promise.resolve()
  })
  vi.mocked(deleteNote).mockImplementation(async (path: string) => {
    files.delete(path)
    await Promise.resolve()
  })
})

describe('openMeetingNote', () => {
  it('creates the meeting and its transcript, cross-linked and typed', async () => {
    const path = await openMeetingNote(memo, '11:06 · Slack', GENERATION)

    expect(path).toBe(MAIN)
    const main = files.get(MAIN) ?? ''
    expect(main).toContain('# 11:06 · Slack')
    expect(main).toContain('- Type: #meeting')
    expect(main).toContain(`[[${BASE}-transcript|transcript]]`)
    expect(main).toContain('## Puntos clave')
    expect(main).toContain('## Decisiones')
    expect(main).toContain('## Tareas')

    const transcript = files.get(TRANSCRIPT) ?? ''
    expect(transcript).toContain('# 11:06 · Slack · transcript')
    expect(transcript).toContain('- Type: #meeting')
    expect(transcript).toContain(`[[${BASE}|11:06 · Slack]]`)
  })

  it('leaves room for the user above the first heading', async () => {
    await openMeetingNote(memo, '11:06 · Slack', GENERATION)

    const body = (files.get(MAIN) ?? '').split('## Puntos clave')[0] ?? ''
    expect(body.trimEnd().endsWith(`[[${BASE}-transcript|transcript]]`)).toBe(true)
  })

  it('backlinks the day once, however many times it opens', async () => {
    await openMeetingNote(memo, '11:06 · Slack', GENERATION)
    await openMeetingNote(memo, '11:06 · Slack', GENERATION)

    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain('## [[Meetings]]')
    expect(daily.split(`[[${BASE}|`)).toHaveLength(2)
  })
})

describe('appending', () => {
  beforeEach(async () => {
    await openMeetingNote(memo, '11:06 · Slack', GENERATION)
  })

  it('puts each kind of line under its own heading', async () => {
    await appendSummary(
      memo,
      { at: new Date(2026, 6, 1, 11, 9), text: 'Vamos con tres colegios' },
      GENERATION,
    )
    await appendDecision(
      memo,
      { at: new Date(2026, 6, 1, 11, 12), text: 'Partimos en agosto' },
      GENERATION,
    )
    await appendTask(memo, 'Martín: enviar el detalle de precios', GENERATION)

    const main = files.get(MAIN) ?? ''
    const points = main.split('## Puntos clave')[1]?.split('##')[0] ?? ''
    const decisions = main.split('## Decisiones')[1]?.split('##')[0] ?? ''
    const tasks = main.split('## Tareas')[1] ?? ''
    expect(points).toContain('**11:09** Vamos con tres colegios')
    expect(decisions).toContain('**11:12** Partimos en agosto')
    expect(tasks).toContain('- [ ] Martín: enviar el detalle de precios')
  })

  it('labels the transcript by who spoke and writes it beside the meeting', async () => {
    await appendTranscript(
      memo,
      { track: 'system', at: new Date(2026, 6, 1, 11, 20), text: '¿Cuántos colegios?' },
      GENERATION,
    )
    await appendTranscript(
      memo,
      { track: 'mic', at: new Date(2026, 6, 1, 11, 20), text: 'Tres por ahora' },
      GENERATION,
    )

    expect(files.get(TRANSCRIPT) ?? '').toContain('- **11:20 · Them** — ¿Cuántos colegios?')
    expect(files.get(TRANSCRIPT) ?? '').toContain('- **11:20 · You** — Tres por ahora')
    // The long thing stays out of the note that gets read.
    expect(files.get(MAIN) ?? '').not.toContain('Tres por ahora')
  })

  it('says nothing about an empty stretch', async () => {
    const before = files.get(MAIN)
    await appendSummary(memo, { at: new Date(), text: '   ' }, GENERATION)
    await appendDecision(memo, { at: new Date(), text: '' }, GENERATION)
    await appendTask(memo, '', GENERATION)
    await appendTranscript(memo, { track: 'mic', at: new Date(), text: '' }, GENERATION)

    expect(files.get(MAIN)).toBe(before)
  })

  it('respects a note the user deleted mid-meeting', async () => {
    files.delete(MAIN)
    files.delete(TRANSCRIPT)

    await appendSummary(memo, { at: new Date(), text: 'Algo' }, GENERATION)
    await appendTranscript(memo, { track: 'mic', at: new Date(), text: 'Algo' }, GENERATION)

    expect(files.has(MAIN)).toBe(false)
    expect(files.has(TRANSCRIPT)).toBe(false)
  })
})

describe('renameMeetingNote', () => {
  beforeEach(async () => {
    await openMeetingNote(memo, '11:06 · Slack', GENERATION)
  })

  it('retitles both notes and every label pointing at them', async () => {
    await renameMeetingNote(memo, '11:06 · Slack · Precios por colegio', GENERATION)

    expect(files.get(MAIN) ?? '').toContain('# 11:06 · Slack · Precios por colegio')
    expect(files.get(TRANSCRIPT) ?? '').toContain(
      '# 11:06 · Slack · Precios por colegio · transcript',
    )
    expect(files.get(TRANSCRIPT) ?? '').toContain(`[[${BASE}|11:06 · Slack · Precios por colegio]]`)
    expect(files.get(DAILY) ?? '').toContain(`[[${BASE}|11:06 · Slack · Precios por colegio]]`)
  })

  it('keeps the paths, so nothing that linked the meeting breaks', async () => {
    await renameMeetingNote(memo, 'Otro nombre', GENERATION)

    expect(files.has(MAIN)).toBe(true)
    expect(files.has(TRANSCRIPT)).toBe(true)
    expect(files.get(MAIN) ?? '').toContain(`aliases: [${BASE}]`)
  })

  it('keeps the opening name when the model had nothing to say', async () => {
    await renameMeetingNote(memo, '   ', GENERATION)

    expect(files.get(MAIN) ?? '').toContain('# 11:06 · Slack')
  })
})

describe('discardMeetingNote', () => {
  it('takes the meeting, the transcript and the line in the day', async () => {
    await openMeetingNote(memo, '11:06 · Slack', GENERATION)
    await discardMeetingNote(memo, GENERATION)

    expect(files.has(MAIN)).toBe(false)
    expect(files.has(TRANSCRIPT)).toBe(false)
    expect(files.get(DAILY) ?? '').not.toContain(BASE)
  })

  it('leaves the rest of the day alone', async () => {
    files.set(
      DAILY,
      `# Tuesday\n\n## [[Meetings]]\n\n- [[${BASE}|11:06 · Slack]]\n- [[otra|Otra]]\n`,
    )
    await discardMeetingNote(memo, GENERATION)

    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain('- [[otra|Otra]]')
    expect(daily).toContain('## [[Meetings]]')
  })
})
