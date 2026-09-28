import { describe, expect, it, vi } from 'vitest'
import { setBridge, hashContent } from '@reflect/core'
import { editTask, mutateTasks } from './note-task.ts'

describe('AST task writes', () => {
  it('rejects an outdated revision without writing', async () => {
    const invoke = vi.fn().mockResolvedValue('+ [ ] different\n')
    setBridge({ invoke, listen: async () => () => {} })
    await expect(
      editTask({ notePath: 'notes/n.md', revision: 'old', astPath: [0] }, 'changed', 1),
    ).rejects.toThrow('note changed')
    expect(invoke.mock.calls.filter(([command]) => command === 'note_write')).toHaveLength(0)
  })
  it('writes a same-note batch once with a content precondition', async () => {
    const source = '+ [ ] one\n+ [ ] two\n'
    const invoke = vi
      .fn()
      .mockImplementation(async (command: string) => (command === 'note_read' ? source : null))
    setBridge({ invoke, listen: async () => () => {} })
    const revision = await hashContent(source)
    await mutateTasks(
      [0, 1].map((index) => ({
        task: { notePath: 'notes/n.md', revision, astPath: [index] },
        edit: { checked: true },
      })),
      1,
    )
    const writes = invoke.mock.calls.filter(([command]) => command === 'note_write')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[1]).toMatchObject({
      expectedContents: source,
      contents: '+ [x] one\n+ [x] two\n',
    })
  })
})
