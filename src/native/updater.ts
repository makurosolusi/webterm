// Thin Electrobun adapter for the native app's updates; every decision lives in updatePolicy.ts.
// Electrobun 2.0.6 Updater (api/sdks/main/core/Updater.ts): checkForUpdate() fetches
// <baseUrl>/stable-macos-arm64-update-v2.json (falls back to -update.json), downloadUpdate() stages the update
// (patch chain, else the full .tar.zst) under the app data folder, applyUpdate() asks the before-quit handlers,
// hands off to a native helper that swaps the bundle once this process exits, and relaunches the new version.
// None of the three throws: failures land in Updater.updateInfo().error. A staged update survives a restart.
// Like main.ts, `electrobun/main` resolves only from the Hutch devkit: excluded from `npm run typecheck`.
import { Updater, Utils } from 'electrobun/main'
import { UPDATE_BASE_URL } from './release.config'
import { FIRST_CHECK_DELAY_MS, INITIAL_UPDATE_STATE, type UpdateDeps, type UpdateOutcome, runUpdateCycle, updatesConfigured } from './updatePolicy'

function currentOutcome(): UpdateOutcome {
  const info = Updater.updateInfo()
  if (info.error) return { kind: 'error', message: info.error }
  if (!info.updateAvailable) return { kind: 'none' }
  return { kind: 'available', version: info.version, hash: info.hash, ready: info.updateReady }
}

/** True when a downloaded update is staged and `installUpdate` can apply it. */
export const updateReady = (): boolean => Updater.updateInfo().updateReady

/** Apply the staged update: the helper replaces the app after this process quits and relaunches it.
 *  Resolves true when the restart is under way, false (with a warn log) when it could not start. */
export async function installUpdate(): Promise<boolean> {
  await Updater.applyUpdate()
  const last = Updater.getStatusHistory().at(-1)
  if (last?.status === 'launching-new-version') return true
  console.warn(`[webterm] cannot install the update: ${Updater.updateInfo().error || last?.message || 'no status'}`)
  return false
}

/** Check on launch (after FIRST_CHECK_DELAY_MS) and then on the policy's schedule; `onReady` runs once per staged
 *  update and run, so the user is told (and the menu offers the restart). Never throws into the caller. */
export function startUpdateChecks(onReady: (version: string) => void): void {
  if (!updatesConfigured(UPDATE_BASE_URL)) {
    console.info('[webterm] updates not configured (UPDATE_BASE_URL in src/native/release.config.ts is empty)')
    return
  }
  const deps: UpdateDeps = {
    check: async () => { await Updater.checkForUpdate(); return currentOutcome() },
    download: async () => { await Updater.downloadUpdate(); return currentOutcome() },
    notifyReady: (version) => {
      Utils.showNotification({ title: 'webterm update ready', body: `Version ${version} is downloaded. Choose webterm › Restart to Update to install it.` })
      onReady(version)
    },
    warn: (m) => console.warn(m),
    info: (m) => console.info(m),
  }
  let state = INITIAL_UPDATE_STATE
  const tick = (): void => {
    runUpdateCycle(state, deps)
      .then((r) => { state = r.state; setTimeout(tick, r.nextDelayMs) })
      // Only an unexpected bug lands here (the Updater reports failures in updateInfo): log it and stop checking
      // for this run rather than retry a broken path.
      .catch((err: unknown) => console.warn('[webterm] update checks stopped after an unexpected error:', err))
  }
  setTimeout(tick, FIRST_CHECK_DELAY_MS)
}
