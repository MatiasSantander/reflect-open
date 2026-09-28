import { ReflectError } from '@reflect/core'
import { describe, expect, it, vi } from 'vitest'
import { createNoteSession } from './note-session.ts'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('note mutation receipts', () => {
  it('waits for load and reports normalization actually saved by the editor', async () => {
    const loaded = deferred()
    let disk = '+ [ ] old\n'
    const session = createNoteSession({
      path: 'a.md',
      io: {
        read: async () => {
          await loaded.promise
          return disk
        },
        write: async (_path, source) => {
          disk = source
        },
      },
      classify: () => 'exact',
      onSnapshot: () => {},
      applyContent: (source) => {
        session.editorChanged(source.replace('new', 'normalized'))
      },
    })
    session.load()
    const saving = session.commitSourceMutation((source) => source.replace('old', 'new'))
    loaded.resolve()
    expect(await saving).toEqual({
      candidateSource: '+ [ ] new\n',
      persistedSource: '+ [ ] normalized\n',
      bufferSource: '+ [ ] normalized\n',
    })
    expect(disk).toBe('+ [ ] normalized\n')
    session.discard()
  })

  it('separates a completed disk write from newer unsaved input', async () => {
    const writing = deferred()
    const finish = deferred()
    const session = createNoteSession({
      path: 'a.md',
      io: {
        read: async () => '+ [ ] old\n',
        write: async () => {
          writing.resolve()
          await finish.promise
        },
      },
      classify: () => 'exact',
      onSnapshot: () => {},
      applyContent: () => {},
    })
    session.load()
    const saving = session.commitSourceMutation((source) => source.replace('old', 'new'))
    await writing.promise
    session.editorChanged('+ [ ] newer\n')
    finish.resolve()
    expect(await saving).toMatchObject({
      persistedSource: '+ [ ] new\n',
      bufferSource: '+ [ ] newer\n',
    })
    session.discard()
  })

  it('retries a new revision conflict without dropping unrelated external changes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let disk = '# Original\n\n+ [ ] work\n'
    let writes = 0
    const session = createNoteSession({
      path: 'a.md',
      io: {
        read: async () => disk,
        write: async (_path, source, expected) => {
          writes++
          if (writes === 1) disk = '# External\n\n+ [ ] work\n'
          if (expected !== disk) throw new ReflectError('revisionConflict', 'changed')
          disk = source
        },
      },
      classify: () => 'exact',
      onSnapshot: () => {},
      applyContent: () => {},
    })
    session.load()
    const result = await session.commitSourceMutation((source) => source.replace('[ ]', '[x]'))
    expect(result?.persistedSource).toBe('# External\n\n+ [x] work\n')
    expect(writes).toBe(2)
    session.discard()
    log.mockRestore()
  })
})

it('rejects a graph switch while an asynchronous mutation is being prepared', async () => {
  const preparing = deferred()
  const finish = deferred()
  let generation = 1
  const write = vi.fn(async () => {})
  const session = createNoteSession({
    path: 'a.md',
    generation: () => generation,
    io: { read: async () => '+ [ ] work\n', write },
    classify: () => 'exact',
    onSnapshot: () => {},
    applyContent: () => {},
  })
  session.load()
  const saving = session.commitSourceMutation(async (source) => {
    preparing.resolve()
    await finish.promise
    return source.replace('[ ]', '[x]')
  }, 1)
  await preparing.promise
  generation = 2
  finish.resolve()
  await expect(saving).rejects.toThrow(/graph changed/)
  expect(write).not.toHaveBeenCalled()
  session.discard()
})

it('rechecks a retargeted path before applying prepared source', async () => {
  const preparing = deferred()
  const finish = deferred()
  const write = vi.fn(async () => {})
  const session = createNoteSession({
    path: 'a.md',
    io: { read: async () => '+ [ ] work\n', write },
    classify: () => 'exact',
    onSnapshot: () => {},
    applyContent: () => {},
  })
  session.load()
  const saving = session.commitSourceMutation(async (source) => {
    preparing.resolve()
    await finish.promise
    return source.replace('[ ]', '[x]')
  })
  await preparing.promise
  session.retarget('b.md')
  finish.resolve()
  await expect(saving).rejects.toThrow(/note or graph changed/)
  expect(write).not.toHaveBeenCalled()
  session.discard()
})
