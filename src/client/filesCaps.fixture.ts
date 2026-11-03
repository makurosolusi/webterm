// Fixture tes: kemampuan server semuanya mati. Dipakai oleh `vi.mock('./fsClient')` di tes Files*
// (slot memanggil `capabilities()`); override per tes lewat `capsWith({ mutate: true })`.
import type { FsCapabilities } from '../shared/fsContract'

export const capsOff: FsCapabilities = {
  mutate: false, viewers: false, watch: false, git: false, quickOpen: false, upload: false, listMax: 0,
}
export const capsWith = (over: Partial<FsCapabilities> = {}): FsCapabilities => ({ ...capsOff, ...over })
/** Potongan mock modul fsClient: `vi.mock('./fsClient', async () => ({ ...fs, ...(await capsMock()) }))`. */
export const capsMock = () => ({ capabilities: async () => capsWith() })
