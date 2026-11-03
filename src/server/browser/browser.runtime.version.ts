// Probe versi Chromium untuk `status().version`: satu panggilan CDP `Browser.getVersion` per masa hidup browser,
// di-cache; gagal = versi tetap absen (dilog), tidak pernah melempar ke pemanggil status().
import { createLogger } from '../logs'
import { CdpClient, readBrowserProduct } from './cdp.client'

const log = createLogger('browser.version')

export interface VersionProbeDeps {
  acquire(workspaceId: string): Promise<string>
  connect?: (wsUrl: string) => Promise<CdpClient>
}

export interface VersionProbe {
  /** Versi ter-cache, atau undefined bila belum/gagal terbaca. */
  get(): string | undefined
  /** Mulai pembacaan di latar belakang bila belum ter-cache dan belum berjalan. */
  probe(workspaceId: string): void
  /** Kosongkan cache (browser berhenti); hasil probe yang sedang jalan dibuang. */
  reset(): void
}

/** Buat probe versi; koneksi CDP ringan dibuka lalu langsung ditutup. */
export function createVersionProbe(d: VersionProbeDeps): VersionProbe {
  const connect = d.connect ?? ((u: string) => CdpClient.connect(u))
  let version: string | undefined
  let epoch = 0 // naik tiap reset: hasil probe lama tidak boleh menimpa cache baru
  let busyEpoch = -1
  const read = async (workspaceId: string): Promise<string> => {
    const cdp = await connect(await d.acquire(workspaceId))
    try { return await readBrowserProduct(cdp) } finally { cdp.close() }
  }
  return {
    get: () => version,
    probe(workspaceId) {
      if (version !== undefined || busyEpoch === epoch) return
      const e = epoch
      busyEpoch = e
      read(workspaceId).then(
        (v) => { if (e === epoch) version = v },
        (err) => log.warn('browser.version', 'browser version unavailable', { ids: { workspaceId }, error: err instanceof Error ? err.message : String(err) }),
      ).finally(() => { if (busyEpoch === e) busyEpoch = -1 })
    },
    reset() { epoch++; version = undefined },
  }
}
