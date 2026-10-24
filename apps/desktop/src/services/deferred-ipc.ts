import type { IpcBridge } from '@reflect/core'

/**
 * An IPC transport whose calls wait for {@link DeferredIpcTransport.connect}.
 */
export interface DeferredIpcTransport {
  readonly transport: IpcBridge
  /**
   * Supply the real transport. Throws on a second call.
   */
  connect(bridge: IpcBridge): void
}

class DeferredIpcTransportImpl implements DeferredIpcTransport {
  #resolveBridge: ((bridge: IpcBridge) => void) | null = null
  readonly #ready = new Promise<IpcBridge>((resolve) => {
    this.#resolveBridge = resolve
  })
  #connected = false

  readonly transport: IpcBridge = {
    invoke: async (command, args) => await (await this.#ready).invoke(command, args),
    listen: async (event, handler) => await (await this.#ready).listen(event, handler),
    listenPlugin: async (plugin, event, handler) => {
      const bridge = await this.#ready
      if (bridge.listenPlugin === undefined) {
        throw new Error(`the connected IPC transport has no plugin events for "${plugin}:${event}"`)
      }
      await bridge.listenPlugin(plugin, event, handler)
    },
  }

  connect(bridge: IpcBridge): void {
    if (this.#connected) {
      throw new Error('the deferred IPC transport is already connected')
    }
    this.#connected = true
    this.#resolveBridge?.(bridge)
  }
}

/**
 * A transport for a host whose real transport is created asynchronously
 * after the services are composed. It has plugin events but no binary path.
 */
export function createDeferredIpcTransport(): DeferredIpcTransport {
  return new DeferredIpcTransportImpl()
}
