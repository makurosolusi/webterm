// Tugas boot file manager: sapu trash kedaluwarsa SEKALI saat start, hanya bila flag MUTATE on
// (flag off = tanpa efek, perilaku lama identik). Fire-and-forget: kegagalan dicatat, tak menjatuhkan boot.
import { filesFlagOn } from './envRegistry.files'
import { sweepTrash } from './fsTrash'
import { createLogger } from './logs'

const log = createLogger('fs')

/** Jalankan sapu trash saat boot bila MUTATE on; kembalikan promise-nya (untuk tes) dan tak pernah menolak. */
export function sweepTrashOnBoot(sweep: () => Promise<number> = sweepTrash): Promise<void> {
  if (!filesFlagOn('MUTATE')) return Promise.resolve()
  return sweep().then(
    (removed) => { log.info('fs.trash-sweep', 'Trash swept at boot', { removed }) },
    (err: unknown) => { log.error('fs.trash-sweep', 'Trash sweep at boot failed', { error: err }) }
  )
}
