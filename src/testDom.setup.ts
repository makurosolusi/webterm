// Per-file vitest setup (`setupFiles` in vite.config.ts). Only acts in jsdom files: vitest globals are
// off, so @testing-library/react never registers its own auto-cleanup; without it, mounted trees outlive
// the test and React's scheduler fires after the jsdom env is torn down ("window is not defined" under
// the threads pool). cleanup() is idempotent: it unmounts what is still tracked and empties the list.
// asyncUtilTimeout: the 1 s default made `findBy*` flake under full-suite load.
import { afterEach } from 'vitest'

if (typeof window !== 'undefined') {
  const { cleanup, configure } = await import('@testing-library/react')
  configure({ asyncUtilTimeout: 5000 })
  afterEach(cleanup)
}
