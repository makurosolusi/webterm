// Katalog tujuh KEMAMPUAN (ENVSIMPLE D1): satu sakelar per kemampuan, murni dan aman dipakai client.
// Prefiks `feature` karena `workspace.capabilities.ts` sudah memakai istilah "capabilities" untuk hal lain.

export const CAPABILITY_IDS =
  ['central', 'workers', 'autonomy', 'browser', 'files', 'filesWrite', 'telegram'] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]
export interface CapabilitySub { key: string; label: string; defaultOn: boolean }
export interface CapabilityDef {
  id: CapabilityId
  title: string // Indonesia; mis. "Agent Pusat"
  blurb: string // fungsi dalam bahasa biasa, BUKAN peringatan
  implies: readonly CapabilityId[] // prasyarat; on hanya bila semuanya on
  primaryKey: string // saklar utama di store override
  needs?: 'telegramToken' | 'chromium'
  subs?: readonly CapabilitySub[] // tampil hanya di kartu induk saat induk on
}
export type CapabilityStatus = 'on' | 'off' | 'needs-step'
export interface CapabilityView {
  id: CapabilityId
  title: string
  blurb: string
  status: CapabilityStatus
  step?: { kind: 'fixChain' | 'telegramToken' | 'chromiumPath'; label: string }
  detail?: string // satu kalimat jujur bila bukan 'on'; "Tersambung sebagai @nama"
  alsoTurnsOn?: CapabilityId[] // untuk teks "ikut menyalakan: ..."
  subs?: { key: string; label: string; on: boolean }[]
}
export interface CapabilitiesResponse {
  capabilities: CapabilityView[] // urut CAPABILITY_IDS
  advanced: {
    agentEngine: { value: 'auto' | 'claude' | 'opencode' | 'mock'; detected: string }
    chromiumPath: { value: string; detected: boolean }
    dataDir: string // read-only
  }
}

/** Katalog kemampuan; urutan = CAPABILITY_IDS dan sekaligus urutan topologis (prasyarat lebih dulu). */
export const CAPABILITIES: Readonly<Record<CapabilityId, CapabilityDef>> = {
  central: {
    id: 'central', title: 'Agent Pusat', implies: [], primaryKey: 'WEBTERM_CENTRAL',
    blurb: 'Asisten yang memahami semua proyek dan node, dan bisa diajak bicara.',
  },
  workers: {
    id: 'workers', title: 'Worker orchestrator', implies: ['central'], primaryKey: 'WEBTERM_ORCHESTRATOR_RUN',
    blurb: 'Izinkan agent menjalankan perintah di komputer ini.',
    subs: [{ key: 'WEBTERM_RUN_REQUIRE_APPROVAL', label: 'Minta persetujuan sebelum worker berjalan', defaultOn: true }],
  },
  autonomy: {
    id: 'autonomy', title: 'Otonomi Agent Pusat', implies: ['workers'], primaryKey: 'WEBTERM_CENTRAL_AUTONOMY',
    blurb: 'Agent Pusat boleh melanjutkan pekerjaan sendiri tanpa diminta tiap langkah.',
  },
  browser: {
    id: 'browser', title: 'Browser di kanvas', implies: [], primaryKey: 'WEBTERM_BROWSER', needs: 'chromium',
    blurb: 'Buka halaman web sebagai node di kanvas.',
  },
  files: {
    id: 'files', title: 'Kelola file', implies: [], primaryKey: 'WEBTERM_FILES_VIEWERS',
    blurb: 'Telusuri dan lihat isi file proyek dari kanvas.',
  },
  filesWrite: {
    id: 'filesWrite', title: 'Ubah dan unggah file', implies: ['files'], primaryKey: 'WEBTERM_FILES_MUTATE',
    blurb: 'Edit, ganti nama, hapus, dan unggah file dari kanvas.',
  },
  telegram: {
    id: 'telegram', title: 'Telegram', implies: [], primaryKey: 'WEBTERM_TELEGRAM', needs: 'telegramToken',
    blurb: 'Terima dan kirim pesan lewat bot Telegram.',
  },
}

/** Kunci turunan: on bila SEMUA kemampuan `needs` on. Ditulis `deriveFlags`, tak tampil di UI. */
export const DERIVED_FLAGS: readonly { key: string; needs: readonly CapabilityId[] }[] = [
  { key: 'WEBTERM_CENTRAL_CHAT', needs: ['central'] },
  { key: 'WEBTERM_CENTRAL_MEMORY', needs: ['central'] },
  { key: 'WEBTERM_CENTRAL_READ_TOOLS', needs: ['central'] },
  { key: 'WEBTERM_CHANNELS', needs: ['telegram'] },
  { key: 'WEBTERM_CENTRAL_TELEGRAM', needs: ['central', 'telegram'] },
  { key: 'WEBTERM_FILES_WATCH', needs: ['files'] },
  { key: 'WEBTERM_FILES_GIT_STATUS', needs: ['files'] },
  { key: 'WEBTERM_FILES_QUICK_OPEN', needs: ['files'] },
  { key: 'WEBTERM_FILES_UPLOAD', needs: ['filesWrite'] },
]

/** Id + prasyarat rekursifnya, urut topologis (prasyarat lebih dulu, id terakhir). */
export function closure(id: CapabilityId): CapabilityId[] {
  const out: CapabilityId[] = []
  const visit = (cur: CapabilityId): void => {
    if (out.includes(cur)) return
    for (const dep of CAPABILITIES[cur].implies) visit(dep)
    out.push(cur)
  }
  visit(id)
  return out
}

/** Kemampuan lain yang ikut mati bila `id` dimatikan (tanpa `id`), urut CAPABILITY_IDS. */
export function dependents(id: CapabilityId): CapabilityId[] {
  return CAPABILITY_IDS.filter((other) => other !== id && closure(other).includes(id))
}

/** Himpunan kemampuan -> nilai kunci (`on`/`off`) untuk SEMUA kunci primer dan turunan, setelah ditutup `implies`. */
export function deriveFlags(on: ReadonlySet<CapabilityId>): Record<string, string> {
  const full = new Set<CapabilityId>()
  for (const id of on) for (const c of closure(id)) full.add(c)
  const flag = (v: boolean): string => (v ? 'on' : 'off')
  const out: Record<string, string> = {}
  for (const id of CAPABILITY_IDS) out[CAPABILITIES[id].primaryKey] = flag(full.has(id))
  for (const d of DERIVED_FLAGS) out[d.key] = flag(d.needs.every((n) => full.has(n)))
  return out
}
