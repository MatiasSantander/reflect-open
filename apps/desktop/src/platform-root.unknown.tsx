import type { IpcBridge } from '@reflect/core'

import { coreServices, pendingDevIpc } from '@/boot.ts'
import { createDevBridge } from '@/dev/dev-bridge.ts'
import { createDevFileStore } from '@/dev/dev-file-store.ts'
import { createDevIndexDb } from '@/dev/dev-index-db.ts'
import { seedGraphFiles } from '@/dev/seed-graph.ts'

async function createDevIpc(): Promise<IpcBridge> {
  const index = await createDevIndexDb()
  const files = createDevFileStore(seedGraphFiles())
  return createDevBridge({ files, index })
}

const { appPlatform } = coreServices.platform

if (pendingDevIpc !== null) {
  pendingDevIpc.connect(await createDevIpc())
}

const { PlatformRoot, warmPlatformRoot } = await (async () => {
  if (appPlatform === 'desktop') {
    const { warmPlatformRoot, PlatformRoot } = await import('@/platform-root.desktop.tsx')
    return { PlatformRoot, warmPlatformRoot }
  } else {
    const { warmPlatformRoot, PlatformRoot } = await import('@/platform-root.mobile.tsx')
    return { PlatformRoot, warmPlatformRoot }
  }
})()

export { PlatformRoot, warmPlatformRoot }
