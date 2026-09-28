import { describe, expect, it } from 'vitest'
import { hashContent } from '../indexing/hash.ts'
import { parseNote } from './extract.ts'
import { hydrateTask, scanReflectTasks } from './task-snapshot.ts'

describe('task first-paragraph projection', () => {
  it('keeps multiline marks and dates while excluding details and square checkboxes', () => {
    const source =
      '+ [ ] **first\n  second** [[2026-09-28]]\n\n  detail [[2026-09-29]]\n\n  > quote\n\n  # Heading\n\n  + [ ] child\n- [ ] square\n'
    const tasks = parseNote({ path: 'notes/a.md', source }).tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({
      firstParagraphMarkdown: '**first\nsecond** [[2026-09-28]]',
      plainText: 'first second 2026-09-28',
      markerText: '[ ]',
      dueDate: '2026-09-28',
    })
    expect(tasks[1]?.breadcrumbs).toEqual(['first second 2026-09-28'])
  })

  it('ignores date-looking code and dates in subsequent blocks', () => {
    const source = '+ [ ] `[[2026-09-28]]`\n\n  [[2026-09-29]]'
    expect(parseNote({ path: 'a.md', source }).tasks[0]?.dueDate).toBeNull()
  })

  it('hydrates UTF-16 ranges in the full CRLF note only at the matching revision', async () => {
    const source = '---\r\naliases: []\r\n---\r\n😀\r\n\r\n+ [X] first\r\n  second\r\n\r\n  detail'
    const projection = parseNote({ path: 'a.md', source }).tasks[0]!
    const row = {
      anchor: {
        notePath: 'a.md',
        revision: await hashContent(source),
        markerOffset: projection.markerOffset,
        markerText: '[X]',
      },
      projection,
    }
    const snapshot = (await hydrateTask(row, source))!
    expect(source.slice(snapshot.ranges.marker.from, snapshot.ranges.marker.to)).toBe('[X]')
    expect(
      source.slice(
        snapshot.ranges.firstParagraphRemoval.from,
        snapshot.ranges.firstParagraphRemoval.to,
      ),
    ).toBe('+ [X] first\r\n  second\r\n')
    expect(await hydrateTask(row, source + '\nchanged')).toBeNull()
    expect(scanReflectTasks(source)[0]?.firstParagraphMarkdown).toBe('first\nsecond')
  })

  it('carries note reference definitions independently from the task paragraph', () => {
    const note = parseNote({
      path: 'a.md',
      source: '+ [ ] [link][ref]\n\n[ref]: https://example.com "Example"',
    })
    expect(note.tasks[0]?.firstParagraphMarkdown).toBe('[link][ref]')
    expect(note.referenceMarkdown).toBe('[ref]: https://example.com "Example"')
  })
})

it('normalizes nested reference definitions without retaining quote prefixes', () => {
  const note = parseNote({
    path: 'a.md',
    source: '+ [ ] [link][ref]\n\n> [ref]:\n>   https://example.com "Example"',
  })
  expect(note.referenceMarkdown).toBe('[ref]:\n  https://example.com "Example"')
})
