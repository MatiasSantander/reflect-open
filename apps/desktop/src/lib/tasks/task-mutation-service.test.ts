import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashContent, projectTaskSnapshots, ReflectError } from '@reflect/core'
import { mutateNoteTasks, mutateTaskBatch } from './task-mutation-service.ts'

const io = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  owner: null as null | {
    path: string
    generation: () => number
    commitSourceMutation: ReturnType<typeof vi.fn>
  },
}))
vi.mock('@reflect/core', async (original) => ({
  ...(await original<typeof import('@reflect/core')>()),
  readNote: io.read,
  writeNote: io.write,
}))
vi.mock('@/editor/open-documents.ts', () => ({ openSession: () => io.owner }))

beforeEach(() => {
  io.read.mockReset()
  io.write.mockReset()
  io.owner = null
})

describe('task mutation persistence', () => {
  it('writes multiple changes to the same note once with exact expected contents', async () => {
    const source = '+ [ ] first\n+ [ ] second\n'
    const tasks = projectTaskSnapshots('a.md', source, await hashContent(source))
    io.read.mockResolvedValue(source)
    io.write.mockResolvedValue(undefined)
    const results = await mutateTaskBatch(
      301,
      tasks.map((base) => ({ base, checked: true })),
    )
    expect(results[0]?.status).toBe('fulfilled')
    expect(io.write).toHaveBeenCalledExactlyOnceWith(
      'a.md',
      '+ [x] first\n+ [x] second\n',
      301,
      source,
    )
  })

  it('retries compare failures with a fresh source and idempotent checked state', async () => {
    const source = '# A\n\n+ [ ] work\n'
    const current = '# B\n\n+ [ ] work\n'
    const [base] = projectTaskSnapshots('a.md', source, await hashContent(source))
    io.read.mockResolvedValueOnce(source).mockResolvedValueOnce(current)
    io.write
      .mockRejectedValueOnce(new ReflectError('revisionConflict', 'changed'))
      .mockResolvedValueOnce(undefined)
    const receipt = await mutateNoteTasks('a.md', 302, [{ base: base!, checked: true }])
    expect(receipt.persistedSource).toBe('# B\n\n+ [x] work\n')
    expect(io.write.mock.calls[1]).toEqual(['a.md', '# B\n\n+ [x] work\n', 302, current])
  })

  it('claims a missing note without overwriting a concurrent creation', async () => {
    io.read.mockRejectedValueOnce(new ReflectError('notFound', 'missing'))
    io.write.mockResolvedValue(undefined)
    const receipt = await mutateNoteTasks('daily/2026-09-28.md', 303, [], true)
    expect(io.write.mock.calls[0]?.[3]).toBeNull()
    expect(receipt.created).toHaveLength(1)
  })

  it('returns partial success across different notes', async () => {
    const source = '+ [ ] work\n'
    const revision = await hashContent(source)
    io.read.mockImplementation(async (path: string) => {
      if (path === 'b.md') throw new ReflectError('io', 'unavailable')
      return source
    })
    io.write.mockResolvedValue(undefined)
    const operations = ['a.md', 'b.md'].map((path) => ({
      base: projectTaskSnapshots(path, source, revision)[0]!,
      checked: true,
    }))
    const results = await mutateTaskBatch(304, operations)
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(io.write).toHaveBeenCalledTimes(1)
  })
})

it('does not route an old graph command into a new graph session with identical source', async () => {
  const source = '+ [ ] work\n'
  const [base] = projectTaskSnapshots('a.md', source, await hashContent(source))
  const commit = vi.fn()
  io.owner = { path: 'a.md', generation: () => 402, commitSourceMutation: commit }
  io.read.mockResolvedValue(source)
  await expect(mutateNoteTasks('a.md', 401, [{ base: base!, checked: true }])).rejects.toThrow(
    /graph changed/,
  )
  expect(commit).not.toHaveBeenCalled()
  expect(io.write).not.toHaveBeenCalled()
})
