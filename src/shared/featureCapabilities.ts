// Katalog tujuh KEMAMPUAN (ENVSIMPLE D1): satu sakelar per kemampuan, murni dan aman dipakai client.
// Prefiks `feature` karena `workspace.capabilities.ts` sudah memakai istilah "capabilities" untuk hal lain.

export const CAPABILITY_IDS =
  ['central', 'workers', 'autonomy', 'browser', 'files', 'filesWrite', 'telegram'] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]
/** `dangerous` = klien wajib minta konfirmasi sebelum menyalakan, sama seperti kartu Otonomi (`CapabilityCard.tsx`). */
export interface CapabilitySub { key: string; label: string; defaultOn: boolean; dangerous?: boolean }
export interface CapabilityDef {
  id: CapabilityId
  title: string // Inggris; mis. "Central Agent"
  blurb: string // fungsi dalam bahasa biasa, BUKAN peringatan
  implies: readonly CapabilityId[] // prasyarat; on hanya bila semuanya on
  primaryKey: string // saklar utama di store override
  needs?: 'telegramToken' | 'chromium' | 'agentEngine'
  subs?: readonly CapabilitySub[] // tampil hanya di kartu induk saat induk on
}
export type CapabilityStatus = 'on' | 'off' | 'needs-step'
export interface CapabilityView {
  id: CapabilityId
  title: string
  blurb: string
  status: CapabilityStatus
  step?: { kind: 'fixChain' | 'telegramToken' | 'chromiumPath' | 'agentEngine'; label: string }
  detail?: string // satu kalimat jujur bila bukan 'on'; "Tersambung sebagai @nama"
  alsoTurnsOn?: CapabilityId[] // untuk teks "ikut menyalakan: ..."
  subs?: { key: string; label: string; on: boolean; dangerous?: boolean }[]
}
export interface CapabilitiesResponse {
  capabilities: CapabilityView[] // urut CAPABILITY_IDS
  advanced: {
    agentEngine: { value: 'auto' | 'claude' | 'mock'; detected: string }
    /** `value` = override tersimpan ('' = otomatis); `active` = biner yang akan dipakai (null = tidak ada);
     *  `overrideInvalid` = override ada tapi berkasnya hilang (TIDAK jatuh ke otomatis); `candidates` = yang ada di disk. */
    chromiumPath: {
      value: string; detected: boolean; active: string | null; source: 'override' | 'auto' | null
      overrideInvalid: boolean; candidates: string[]
    }
    dataDir: string // read-only
    /** "Download Chromium": `supported` = the server's platform has a build; state/percent of a running download.
     *  Optional on the wire like `headlessForced`: the client hides the option / lock when absent. */
    chromiumDownload?: { supported: boolean; state: ChromiumDownloadState; percent: number }
    /** `no_display`: Linux server without DISPLAY/WAYLAND_DISPLAY, the browser can only run headless. */
    headlessForced?: 'no_display' | null
  }
}

export type ChromiumDownloadState = 'idle' | 'downloading' | 'done' | 'failed'
/** `GET /api/capabilities/chromium-download` (and the POST replies). */
export interface ChromiumDownloadStatus {
  state: ChromiumDownloadState; percent: number; bytes: number; total: number
  error: string | null; executablePath: string | null
}

/** Katalog kemampuan; urutan = CAPABILITY_IDS dan sekaligus urutan topologis (prasyarat lebih dulu). */
export const CAPABILITIES: Readonly<Record<CapabilityId, CapabilityDef>> = {
  central: {
    id: 'central', title: 'Central Agent', implies: [], primaryKey: 'WEBTERM_CENTRAL', needs: 'agentEngine',
    blurb: 'An assistant that understands all your projects and nodes, and that you can talk to.',
    subs: [
      { key: 'WEBTERM_CENTRAL_SKILLS', label: 'Let Central use skills you review and approve', defaultOn: true },
      { key: 'WEBTERM_CENTRAL_SKILL_PROPOSE', label: 'Suggest new skills', defaultOn: true },
      { key: 'WEBTERM_CENTRAL_CHECKPOINT', label: 'Summarize long conversations', defaultOn: true },
    ],
  },
  workers: {
    id: 'workers', title: 'Worker orchestrator', implies: ['central'], primaryKey: 'WEBTERM_ORCHESTRATOR_RUN',
    blurb: 'Let agents run commands on this computer.',
    subs: [{ key: 'WEBTERM_RUN_REQUIRE_APPROVAL', label: 'Ask for approval before a worker runs', defaultOn: true }],
  },
  autonomy: {
    id: 'autonomy', title: 'Central Agent autonomy', implies: ['workers'], primaryKey: 'WEBTERM_CENTRAL_AUTONOMY',
    blurb: 'The Central Agent may continue work on its own without being asked at every step.',
  },
  browser: {
    id: 'browser', title: 'Browser on canvas', implies: [], primaryKey: 'WEBTERM_BROWSER', needs: 'chromium',
    blurb: 'Open web pages as nodes on the canvas.',
    subs: [{ key: 'WEBTERM_BROWSER_AGENT', label: 'Let agents drive the browser', defaultOn: true, dangerous: true }],
  },
  files: {
    id: 'files', title: 'Files', implies: [], primaryKey: 'WEBTERM_FILES_VIEWERS',
    blurb: 'Browse and view project files from the canvas.',
  },
  filesWrite: {
    id: 'filesWrite', title: 'Edit and upload files', implies: ['files'], primaryKey: 'WEBTERM_FILES_MUTATE',
    blurb: 'Edit, rename, delete, and upload files from the canvas.',
  },
  telegram: {
    id: 'telegram', title: 'Telegram', implies: [], primaryKey: 'WEBTERM_TELEGRAM', needs: 'telegramToken',
    blurb: 'Receive and send messages through a Telegram bot.',
  },
}

/** Kunci turunan: on bila SEMUA kemampuan `needs` on. Ditulis `deriveFlags`, tak tampil di UI. */
export const DERIVED_FLAGS: readonly { key: string; needs: readonly CapabilityId[] }[] = [
  { key: 'WEBTERM_CENTRAL_MEMORY', needs: ['central'] },
  { key: 'WEBTERM_CENTRAL_READ_TOOLS', needs: ['central'] },
  { key: 'WEBTERM_FILES_WATCH', needs: ['files'] },
  { key: 'WEBTERM_FILES_GIT_STATUS', needs: ['files'] },
  { key: 'WEBTERM_FILES_QUICK_OPEN', needs: ['files'] },
  { key: 'WEBTERM_FILES_UPLOAD', needs: ['filesWrite'] },
]

/**
 * Pengaturan bernilai yang IKUT kartu (seperti sub-opsi: dibaca langsung oleh pemiliknya, bukan lewat `isEnabled`).
 * Nilai = `on` bila semua `needs` on, selain itu `off`; kunci yang muncul dua kali: entri pertama yang terpenuhi
 * menang. Nilai eksplisit dari shell/.env tidak ditimpa (lihat `commit` di layanan).
 */
export const LINKED_SETTINGS: readonly { key: string; needs: readonly CapabilityId[]; on: string; off: string }[] = [
  // Worker on = Central boleh mengusulkan dan menjalankan worker; tiap aksi tetap lewat kartu persetujuan (propose).
  // (WEBTERM_CENTRAL_TOOLS/_PLANNER dulu ditulis di sini tanpa pembaca runtime; dihapus, nilai tersimpan lama diabaikan.)
  // Tanpa kartu per aksi (auto) hanya lewat kartu Otonomi yang berbahaya; urutan ini = auto menang atas propose.
  { key: 'WEBTERM_CENTRAL_AGENTS', needs: ['autonomy'], on: 'auto', off: 'off' },
  { key: 'WEBTERM_CENTRAL_AGENTS', needs: ['workers'], on: 'propose', off: 'off' },
  // Working on its own brings the tools that make it work well; Settings no longer shows them.
  { key: 'WEBTERM_KNOWLEDGE', needs: ['autonomy'], on: 'on', off: 'off' },
  { key: 'WEBTERM_CENTRAL_RELIABILITY', needs: ['autonomy'], on: 'on', off: 'off' },
  { key: 'WEBTERM_AGENT_MAIL', needs: ['autonomy'], on: 'on', off: 'off' },
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

/** Himpunan kemampuan -> nilai `LINKED_SETTINGS` (setelah ditutup `implies`). */
export function linkedSettings(on: ReadonlySet<CapabilityId>): Record<string, string> {
  const full = new Set<CapabilityId>()
  for (const id of on) for (const c of closure(id)) full.add(c)
  const out: Record<string, string> = {}
  const met = new Set<string>()
  for (const l of LINKED_SETTINGS) {
    if (met.has(l.key)) continue
    const ok = l.needs.every((n) => full.has(n))
    if (ok) met.add(l.key)
    out[l.key] = ok ? l.on : l.off
  }
  return out
}
