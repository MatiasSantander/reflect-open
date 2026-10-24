import { useMemo } from 'react'
import type { CoreServices, MobileServices } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * `useCoreServices()` for the mobile surface tree, with the mobile-only
 * services merged in. The mobile tree runs only on a mobile platform, where
 * `app.mobile` always exists.
 */
export function useMobileAppServices(): CoreServices & MobileServices {
  const app = useCoreServices()
  return useMemo(() => {
    if (app.mobile === null) {
      throw new Error('useMobileAppServices: the mobile services exist only on a mobile platform')
    }
    return { ...app, ...app.mobile }
  }, [app])
}
