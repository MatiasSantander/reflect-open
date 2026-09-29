import { describe, expect, it } from 'vitest'
import { makeOpenTask as task } from './open-task-fixture.ts'
import { asCompleted, asOpen, withEditedTask, withoutTasks } from './task-cache.ts'

const a = task({ astPath: [1], displayText: 'a' })
const b = task({ astPath: [2], displayText: 'b' })
const c = task({ astPath: [3], displayText: 'c' })

describe('withoutTasks', () => {
  it('drops every matching row and keeps the rest', () => {
    expect(withoutTasks([a, b, c], [a, c])).toEqual([b])
  })

  it('leaves an undefined (not-loaded) list untouched', () => {
    expect(withoutTasks(undefined, [a])).toBeUndefined()
  })
})

describe('asCompleted', () => {
  it('prepends the tasks as checked, de-duping any already present', () => {
    const existingChecked = { ...b, checked: true }
    const result = asCompleted([existingChecked], [a, b])
    expect(result).toEqual([
      { ...a, checked: true },
      { ...b, checked: true },
    ])
  })

  it('is a no-op when the completed list is not loaded', () => {
    expect(asCompleted(undefined, [a])).toBeUndefined()
  })
})

describe('asOpen', () => {
  it('appends the tasks as unchecked, de-duping any already present', () => {
    const checked = { ...a, checked: true }
    const result = asOpen([b, checked], [checked])
    expect(result).toEqual([b, a])
  })

  it('materializes an undefined open list with the reopened rows', () => {
    expect(asOpen(undefined, [{ ...a, checked: true }])).toEqual([a])
  })
})

describe('withEditedTask', () => {
  it('rewrites the matching row’s display text and Markdown, leaving others', () => {
    expect(withEditedTask([a, b], b, 'edited')).toEqual([
      a,
      { ...b, text: 'edited', displayText: 'edited' },
    ])
  })

  it('stores plain text (markdown stripped) while Markdown keeps the markup', () => {
    const [edited] = withEditedTask([a], a, 'see [[Foo]] now') ?? []
    expect(edited?.text).toBe('see [[Foo]] now')
    // `text` drives search + the row label, so it must be the plain rendering.
    expect(edited?.displayText).not.toContain('[[')
    expect(edited?.displayText).toContain('Foo')
  })

  it('leaves an undefined list untouched', () => {
    expect(withEditedTask(undefined, a, 'x')).toBeUndefined()
  })
})
