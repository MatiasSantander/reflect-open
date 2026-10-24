import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '@reflect/core/testing'
import { createDeferredIpcTransport } from '@/services/deferred-ipc.ts'

describe('createDeferredIpcTransport', () => {
  it('holds calls until a transport connects', async () => {
    const deferred = createDeferredIpcTransport()
    const pending = deferred.transport.invoke('app_version', {})
    deferred.connect(createTestIpcBridgeService({ commands: { app_version: () => '1' } }).transport)
    await expect(pending).resolves.toBe('1')
  })

  it('refuses a second transport', () => {
    const deferred = createDeferredIpcTransport()
    deferred.connect(createTestIpcBridgeService().transport)
    expect(() => deferred.connect(createTestIpcBridgeService().transport)).toThrow(
      /already connected/,
    )
  })

  it('has plugin events but no binary path', () => {
    const { transport } = createDeferredIpcTransport()
    expect(transport.listenPlugin).toBeDefined()
    expect(transport.invokeBinary).toBeUndefined()
  })
})
