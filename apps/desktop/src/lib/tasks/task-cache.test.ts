import { describe, expect, it } from 'vitest'
import { makeOpenTask as task } from './open-task-fixture.ts'
import {
  asCompleted,
  asOpen,
  withCheckedMarker,
  withEditedTask,
  withoutTasks,
} from './task-cache.ts'

const a = task({ astPath: [1], text: 'a' })
const b = task({ astPath: [2], text: 'b' })
const c = task({ astPath: [3], text: 'c' })

describe('withoutTasks', () => {
  it('drops every matching row and keeps the rest', () => {
    expect(withoutTasks([a, b, c], [a, c])).toEqual([b])
  })

  it('leaves an undefined (not-loaded) list untouched', () => {
    expect(withoutTasks(undefined, [a])).toBeUndefined()
  })
})

describe('withCheckedMarker', () => {
  it('changes checked state without changing Markdown', () => {
    expect(withCheckedMarker(a, true)).toEqual({ ...a, checked: true, firstParagraphMarkdown: 'a' })
    expect(withCheckedMarker({ ...a, checked: true, firstParagraphMarkdown: 'a' }, false)).toEqual({
      ...a,
      checked: false,
      firstParagraphMarkdown: 'a',
    })
  })
})

describe('asCompleted', () => {
  it('prepends the tasks as checked, de-duping any already present', () => {
    const existingChecked = withCheckedMarker(b, true)
    const result = asCompleted([existingChecked], [a, b])
    expect(result).toEqual([withCheckedMarker(a, true), withCheckedMarker(b, true)])
  })

  it('is a no-op when the completed list is not loaded', () => {
    expect(asCompleted(undefined, [a])).toBeUndefined()
  })
})

describe('asOpen', () => {
  it('appends the tasks as unchecked, de-duping any already present', () => {
    const checked = withCheckedMarker(a, true)
    const result = asOpen([b, checked], [checked])
    expect(result).toEqual([b, a])
  })

  it('materializes an undefined open list with the reopened rows', () => {
    expect(asOpen(undefined, [withCheckedMarker(a, true)])).toEqual([a])
  })
})

describe('withEditedTask', () => {
  it('rewrites the matching row’s display text and Markdown, leaving others', () => {
    expect(withEditedTask([a, b], b, 'edited')).toEqual([
      a,
      { ...b, firstParagraphMarkdown: 'edited', text: 'edited' },
    ])
  })

  it('stores plain text (markdown stripped) while Markdown keeps the markup', () => {
    const [edited] = withEditedTask([a], a, 'see [[Foo]] now') ?? []
    expect(edited?.firstParagraphMarkdown).toBe('see [[Foo]] now')
    // `text` drives search + the row label, so it must be the plain rendering.
    expect(edited?.text).not.toContain('[[')
    expect(edited?.text).toContain('Foo')
  })

  it('leaves an undefined list untouched', () => {
    expect(withEditedTask(undefined, a, 'x')).toBeUndefined()
  })
})
