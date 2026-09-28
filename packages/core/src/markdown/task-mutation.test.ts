import { describe, expect, it } from 'vitest'
import { hashContent } from '../indexing/hash.ts'
import {
  mapTaskOffset,
  mergeTaskParagraph,
  planTaskMutations,
  projectTaskSnapshots,
  scheduleTaskParagraph,
} from './task-mutation.ts'

async function snapshot(source: string) {
  const revision = await hashContent(source)
  return { revision, tasks: projectTaskSnapshots('a.md', source, revision) }
}

describe('task mutations', () => {
  it('combines edit, completion and scheduling against one original snapshot', async () => {
    const source = '+ [ ] old\n  wrapped\n\n  detail [[2026-09-29]]\n\n+ [ ] next\n'
    const { revision, tasks } = await snapshot(source)
    const result = planTaskMutations(
      source,
      revision,
      [
        { base: tasks[0]!, firstParagraphMarkdown: '**new\nparagraph**' },
        { base: tasks[0]!, checked: true, dueDate: '2026-09-28' },
        { base: tasks[1]!, checked: true },
      ],
      () => undefined,
    )
    expect(result.source).toBe(
      '+ [x] **new\n  paragraph** [[2026-09-28]]\n\n  detail [[2026-09-29]]\n\n+ [x] next\n',
    )
    const projected = projectTaskSnapshots('a.md', result.source, 'after')
    expect(mapTaskOffset(tasks[1]!.anchor.markerOffset, result.edits)).toBe(
      projected[1]!.anchor.markerOffset,
    )
  })

  it('refuses an old offset now occupied by a duplicate task', async () => {
    const original = '+ [ ] same\n'
    const { tasks } = await snapshot(original)
    const current = '+ [ ] same\n' + original
    expect(() =>
      planTaskMutations(current, 'changed', [{ base: tasks[0]!, checked: true }], () => original),
    ).toThrow(/Repeated tasks/)
  })

  it('maps an unchanged unique task after a known external prefix edit', async () => {
    const original = '# Note\n\n+ [ ] work\n'
    const { tasks } = await snapshot(original)
    const current = '# Longer note\n\n+ [ ] work\n'
    const result = planTaskMutations(
      current,
      'changed',
      [{ base: tasks[0]!, checked: true }],
      () => original,
    )
    expect(result.source).toBe('# Longer note\n\n+ [x] work\n')
  })

  it('refuses missing base revisions even when the old offset text matches', async () => {
    const { tasks } = await snapshot('+ [ ] same\n')
    expect(() =>
      planTaskMutations(
        '+ [ ] same\nextra',
        'new',
        [{ base: tasks[0]!, remove: true }],
        () => undefined,
      ),
    ).toThrow(/refreshed/)
  })

  it('removes only the first paragraph and leaves all detail bytes intact', async () => {
    const source = '+ [ ] first\r\n  second\r\n\r\n  > detail\r\n\r\n  + [ ] child\r\n'
    const { revision, tasks } = await snapshot(source)
    const result = planTaskMutations(
      source,
      revision,
      [{ base: tasks[0]!, remove: true }],
      () => undefined,
    )
    expect(result.source).toBe('\r\n  > detail\r\n\r\n  + [ ] child\r\n')
  })

  it('merges disjoint paragraph edits and refuses overlap', () => {
    expect(mergeTaskParagraph('alpha beta', 'ALPHA beta', 'alpha BETA')).toBe('ALPHA BETA')
    expect(() => mergeTaskParagraph('alpha', 'ALPHA', 'other')).toThrow(/draft/)
  })

  it('sets the first date and clears all dates without changing code', () => {
    const source = '`[[2026-09-28]]` [[2026-09-29]] [[2026-09-30]]'
    expect(scheduleTaskParagraph(source, '2026-10-01')).toBe(
      '`[[2026-09-28]]` [[2026-10-01]] [[2026-09-30]]',
    )
    expect(scheduleTaskParagraph(source, null)).toBe('`[[2026-09-28]]`')
  })
})

it('does not treat an inserted task with the same checkbox prefix as a paragraph edit', async () => {
  const previous = '+ [ ] a\n'
  const { tasks } = await snapshot(previous)
  const current = '+ [ ] b\n+ [ ] a\n'
  const plan = planTaskMutations(
    current,
    'changed',
    [{ base: tasks[0]!, checked: true }],
    () => previous,
  )
  expect(plan.source).toBe('+ [ ] b\n+ [x] a\n')
})

it('continues at the end of the parent context while resolving a cleared first paragraph', async () => {
  const source = '- Project\n  + [ ] first\n  + [ ] second\n\n# Other\n'
  const { revision, tasks } = await snapshot(source)
  const plan = planTaskMutations(
    source,
    revision,
    [{ base: tasks[0]!, remove: true, continue: true }],
    () => undefined,
  )
  expect(plan.source).toBe('- Project\n  + [ ] second\n  + [ ] \n\n# Other\n')
})

it('can remove and continue a task with no later detail block', async () => {
  const source = '+ [ ] first\n'
  const { revision, tasks } = await snapshot(source)
  const plan = planTaskMutations(
    source,
    revision,
    [{ base: tasks[0]!, remove: true, continue: true }],
    () => undefined,
  )
  expect(plan.source).toBe('+ [ ] \n')
})

it('edits and converts one paragraph atomically while retaining details', async () => {
  const source = '+ [ ] before\n  wrapped\n\n  > detail\n'
  const { revision, tasks } = await snapshot(source)
  const result = planTaskMutations(
    source,
    revision,
    [
      {
        base: tasks[0]!,
        firstParagraphMarkdown: '**after\nwrapped**',
        toBullet: true,
      },
    ],
    () => undefined,
  )
  expect(result.source).toBe('+ **after\n  wrapped**\n\n  > detail\n')
})
