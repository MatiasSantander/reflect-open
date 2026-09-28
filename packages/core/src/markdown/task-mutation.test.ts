import { describe, expect, it } from 'vitest'
import { parseMarkdownAst } from '@meowdown/markdown'
import { editTaskDocument } from './task-mutation.ts'

describe('AST task mutations', () => {
  it('edits the full first paragraph and preserves details', () => {
    const source =
      '---\nid: keep\n---\n\n+ [ ] old\n  second line\n\n  > quote\n\n  ## heading\n\n  + [ ] nested\n'
    const result = editTaskDocument(source, [
      { astPath: [0], firstParagraphMarkdown: '**new**\nline', checked: true },
    ])
    expect(result.source).toContain('---\nid: keep\n---\n\n')
    expect(result.source).toContain('+ [x] **new**\n  line')
    expect(result.source).toContain('> quote')
    expect(result.source).toContain('## heading')
    expect(result.tasks).toHaveLength(2)
  })
  it('locates a batch before deleting siblings and promotes details', () => {
    const result = editTaskDocument('+ [ ] parent\n  + [ ] child\n+ [ ] sibling\n', [
      { astPath: [0], remove: true },
      { astPath: [1], checked: true },
    ])
    expect(result.source).toBe('+ [ ] child\n+ [x] sibling\n')
    expect(result.paths.get('[0,1]')).toEqual([0])
  })
  it('creates and continues empty tasks', () => {
    const initial = editTaskDocument('', [], true)
    expect(initial.createdPath).toEqual([0])
    const next = editTaskDocument(initial.source, [
      { astPath: [0], firstParagraphMarkdown: 'first', insertAfter: true },
    ])
    expect(next.createdPath).toEqual([1])
    expect(next.tasks.map((task) => task.firstParagraphMarkdown)).toEqual(['first', ''])
  })
  it('converts a task to a collapsed bullet, preserving descendants', () => {
    const result = editTaskDocument('+ [ ] parent\n  + [ ] child\n', [
      { astPath: [0], toBullet: true },
    ])
    expect(result.source).toBe('+ parent\n  + [ ] child\n')
    expect(result.tasks).toHaveLength(1)
  })
  it('keeps a no-op byte-identical and refuses a missing node', () => {
    const source = '+   [ ] same\r\n'
    expect(editTaskDocument(source, [{ astPath: [0], checked: false }]).source).toBe(source)
    expect(() => editTaskDocument(source, [{ astPath: [99], remove: true }])).toThrow()
    expect(parseMarkdownAst(source).children).toHaveLength(1)
  })
})
