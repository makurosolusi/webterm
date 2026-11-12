// Tugas sapu trash file manager: SEKALI saat start, lalu dari tick reaper ledger paling sering sekali per jam,
// hanya bila flag MUTATE on (flag off = tanpa efek). Fire-and-forget: kegagalan dicatat, tak pernah melempar.
import { filesFlagOn } from './envRegistry.files'
import { sweepTrash } from './fsTrash'
import { createLogger } from './logs'

const log = createLogger('fs')

/** Jeda minimum antar sapu trash dari reaper (boot sudah menyapu sekali). */
export const TRASH_SWEEP_INTERVAL_MS = 60 * 60 * 1000

function runSweep(sweep: () => Promise<number>, when: 'boot' | 'reaper'): Promise<void> {
  if (!filesFlagOn('MUTATE')) return Promise.resolve()
  return sweep().then(
    (removed) => { if (when === 'boot' || removed > 0) log.info('fs.trash-sweep', `Trash swept (${when})`, { removed }) },
    (err: unknown) => { log.error('fs.trash-sweep', `Trash sweep (${when}) failed`, { error: err }) }
  )
}

/** Jalankan sapu trash saat boot bila MUTATE on; kembalikan promise-nya (untuk tes) dan tak pernah menolak. */
export function sweepTrashOnBoot(sweep: () => Promise<number> = sweepTrash): Promise<void> {
  return runSweep(sweep, 'boot')
}

/**
 * Sapu trash untuk tick reaper ledger: paling sering sekali per `intervalMs` (jeda pertama dihitung dari
 * pembuatan, karena boot baru menyapu) dan tak pernah dua sapu bersamaan. `tick` mengembalikan promise
 * sapu yang dimulai (untuk tes) atau null bila belum waktunya.
 */
export function createTrashReaper(sweep: () => Promise<number> = sweepTrash, intervalMs = TRASH_SWEEP_INTERVAL_MS, start = Date.now()) {
  let nextAt = start + intervalMs
  let running: Promise<void> | null = null
  return {
    tick(now: number = Date.now()): Promise<void> | null {
      if (running || now < nextAt) return null
      nextAt = now + intervalMs
      running = runSweep(sweep, 'reaper').finally(() => { running = null })
      return running
    },
  }
}
