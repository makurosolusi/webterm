// First-run setup mount for App: the wizard shows itself from `?setup=`; this opens it once per
// page load while setup is unfinished (settings hydrated first, so an existing install never sees it).
import { useEffect } from 'react'
import SetupDialog from './setup/SetupDialog'
import { openSetup } from './setup/setup.open'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'

// Module-level, not a ref: a remount (route change, auth flip) must not reopen a dialog the user closed.
let autoOpened = false

/** Test hook: forget that this page load already auto-opened the wizard. */
export function resetSetupAutoOpen(): void {
  autoOpened = false
}

/** Mounts the setup wizard and auto-opens it once when `hydrated` and setup is not completed. */
export default function AppSetup({ settings, update, hydrated }: { settings: Settings; update: (patch: SettingsPatch) => void; hydrated: boolean }) {
  const incomplete = hydrated && settings.setup.completedAt == null
  useEffect(() => {
    if (!incomplete || autoOpened) return
    autoOpened = true
    openSetup()
  }, [incomplete])
  return <SetupDialog settings={settings} update={update} />
}
