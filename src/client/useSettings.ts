// Settings sisi client: baca sekali saat mount, tulis di-coalesce.
//
// Pola persis dari nodeterm `src/renderer/state/settings.ts`: state in-memory sinkron (UI dan
// xterm bereaksi seketika), persistensi membuntut dengan paling banyak satu request per jendela
// 300 ms, selalu membawa snapshot TERBARU. Alasannya sama di sini: kontrol settings memanggil
// update per gerakan slider / per ketukan, dan setiap tulis adalah satu request HTTP.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { fitsKeepalive, SETTINGS_KEEPALIVE_MAX_BYTES } from './api'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/settings'
import { applySettingsPatch, mergeSettingsPatches, type SettingsPatch } from '../shared/settings.patch'
import { createSettingsHistory, type SettingsChange, type SettingsHistory } from './settingsHistory'
import { setCustomAgentBaseResolver, type AgentId, type BuiltinAgentId } from '../shared/workspace'

export const SAVE_COALESCE_MS = 300

export interface Coalescer<T> {
  /** Catat nilai terbaru; jadwalkan flush bila belum ada yang terjadwal. */
  push(value: T): void
  /** Send the pending value NOW (used by `beforeunload`); resolves once the last send settled. */
  flush(): Promise<void>
}

/**
 * Trailing-edge coalescer: timer pertama yang menyala menetapkan jendela, `push` berikutnya di
 * dalam jendela itu digabung ke payload tertunda — jadi N gerakan slider jadi satu `send`.
 *
 * `merge` wajib disetel bila payload-nya PATCH: defaultnya last-wins, dan last-wins pada patch
 * akan MENJATUHKAN kunci yang disetel lebih awal di jendela yang sama (geser fontSize lalu
 * toggle kursor dalam 300 ms ⇒ fontSize hilang). Beda dari nodeterm, yang mengirim snapshot
 * penuh dan karena itu tidak butuh penggabung — tapi snapshot penuh membuat dua tab saling
 * menimpa kunci yang tidak mereka sentuh.
 *
 * Terpisah dari hook dan bebas DOM supaya bisa dites di node-env; `onError` ada karena `send`
 * di sini async dan tidak punya pemanggil yang bisa menangkap rejection-nya.
 */
export function createCoalescer<T>(
  send: (value: T) => Promise<void>,
  opts: {
    ms?: number
    merge?: (pending: T, next: T) => T
    onError?: (err: unknown) => void
  } = {}
): Coalescer<T> {
  const ms = opts.ms ?? SAVE_COALESCE_MS
  const merge = opts.merge ?? ((_pending: T, next: T) => next)
  const onError = opts.onError ?? ((err: unknown) => console.error('settings save failed', err))
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  let last: Promise<void> = Promise.resolve()
  const fire = (): Promise<void> => {
    if (!pending) return last
    const { value } = pending
    pending = null
    last = send(value).catch(onError)
    return last
  }
  return {
    push(value) {
      pending = pending ? { value: merge(pending.value, value) } : { value }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        fire()
      }, ms)
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      return fire()
    },
  }
}

/** The settings endpoint. No credential in the URL: the `wt_ui` session cookie rides along. */
export function settingsUrl(): string {
  return '/api/settings'
}

async function putSettings(patch: SettingsPatch): Promise<void> {
  const body = JSON.stringify(patch)
  // `keepalive`: a flush on pagehide must outlive the document (see `fitsKeepalive`).
  const res = await fetch(settingsUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: fitsKeepalive(body, SETTINGS_KEEPALIVE_MAX_BYTES),
  })
  if (!res.ok) throw new Error(`PUT /api/settings -> ${res.status}`)
}

/** Saves of the mounted useSettings; `flushSettingsSaves` waits for them. */
const savers = new Set<Coalescer<SettingsPatch>>()

/** Send pending settings edits now and wait for them: for a server call that reads stored settings
 *  right after an edit (e.g. testing a launch profile just saved), which would otherwise race the
 *  300 ms save window. */
export const flushSettingsSaves = async (): Promise<void> => { await Promise.all([...savers].map((c) => c.flush())) }

/** Refetch of each mounted useSettings. */
const reloaders = new Set<() => Promise<void>>()

/** Re-read stored settings into every mounted useSettings (pending edits are sent first). For writers
 *  that PUT settings directly (the Claude provider card, the setup wizard) and after a refused save, so
 *  the in-memory copy never goes stale and a later edit is not built on a list missing their entries. */
export const reloadSettings = async (): Promise<void> => {
  await flushSettingsSaves()
  await Promise.all([...reloaders].map((r) => r()))
}

// Snapshot modul supaya resolver `baseAgent` di bawah bisa dibaca sinkron dari luar React.
let current: Settings = DEFAULT_SETTINGS

// Lookup `custom:<uuid>` → `baseAgent` yang dibutuhkan `capabilityAgentId` (lihat catatan
// BaseResolver di `shared/workspace.ts`). Didaftarkan sekali di sini karena ini satu-satunya
// modul client yang memegang settings; tanpa ini agent custom tidak mewarisi kapabilitas apa pun.
setCustomAgentBaseResolver((id: AgentId): BuiltinAgentId | undefined => {
  for (const a of current.customAgents) if (a.id === id) return a.baseAgent
  return undefined
})

export interface UseSettings {
  settings: Settings
  /** True setelah GET pertama selesai, supaya logika first-run bisa menunggu. */
  hydrated: boolean
  /** Terapkan patch ke state sekarang; persistensi menyusul (coalesce 300 ms). */
  update(patch: SettingsPatch): void
  /** Undo/redo of `update` (see `./settingsHistory`). */
  history: SettingsUndo
}

/** What happened last, for the Settings panel toast. `seq` changes on every event. */
export interface SettingsNotice {
  seq: number
  kind: 'changed' | 'undone' | 'redone'
  change: SettingsChange
}

export interface SettingsUndo {
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  notice: SettingsNotice | null
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings>(current)
  const [hydrated, setHydrated] = useState(false)
  const saver = useRef<Coalescer<SettingsPatch> | null>(null)
  if (!saver.current) {
    saver.current = createCoalescer(putSettings, {
      merge: mergeSettingsPatches, // entry keys keep both patches' entries
      // A refused save (e.g. 409: deleting a launch profile still in use) left the optimistic copy
      // ahead of the server: re-read it so the UI shows what is really stored.
      onError: (err) => { console.error('settings save failed', err); void reloadSettings() },
    })
  }

  useEffect(() => {
    let alive = true
    // ponytail: an edit made while this GET is in flight shows the server's older value until the next
    // reload (the edit itself is saved); replay edits made since the fetch if that ever matters.
    const load = (): Promise<void> => fetch(settingsUrl(), { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/settings -> ${res.status}`)
        return res.json()
      })
      .then((raw) => {
        if (!alive) return
        // mergeSettings juga di jalur BACA: respons bisa datang dari server versi lain.
        current = mergeSettings(raw)
        setSettings(current)
        setHydrated(true)
      })
      .catch((err) => {
        // Default yang bisa dipakai lebih baik daripada canvas kosong; jangan telan diam-diam.
        console.error('settings load failed, using the last known settings', err)
        if (alive) setHydrated(true)
      })
    void load()
    reloaders.add(load)
    return () => { alive = false; reloaders.delete(load) }
  }, [])

  // Reload/close/hide inside the coalesce window must not drop the last edit. `pagehide` and
  // `visibilitychange` too: mobile browsers and the bfcache skip `beforeunload` (data-209-4).
  useEffect(() => {
    const own = saver.current as Coalescer<SettingsPatch>
    savers.add(own)
    const flush = (): void => { void own.flush() }
    const onVisibility = (): void => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      savers.delete(own)
    }
  }, [])

  const hist = useRef<SettingsHistory | null>(null)
  if (!hist.current) hist.current = createSettingsHistory()
  const [notice, setNotice] = useState<SettingsNotice | null>(null)
  const announce = useCallback((kind: SettingsNotice['kind'], change: SettingsChange | undefined) => {
    if (change) setNotice((prev) => ({ seq: (prev?.seq ?? 0) + 1, kind, change }))
  }, [])

  const apply = useCallback((patch: SettingsPatch) => {
    current = applySettingsPatch(current, patch)
    setSettings(current)
    // Kirim patch, bukan snapshot penuh: server me-merge-nya, jadi dua tab yang menyetel kunci
    // berbeda tidak saling menimpa kunci yang tidak mereka sentuh.
    saver.current?.push(patch)
  }, [])

  const update = useCallback((patch: SettingsPatch) => {
    announce('changed', hist.current?.record(current, patch))
    apply(patch)
  }, [apply, announce])

  const undo = useCallback(() => {
    const c = hist.current?.undo()
    if (c) apply(c.before)
    announce('undone', c)
  }, [apply, announce])

  const redo = useCallback(() => {
    const c = hist.current?.redo()
    if (c) apply(c.after)
    announce('redone', c)
  }, [apply, announce])

  const history: SettingsUndo = {
    undo, redo, notice, canUndo: hist.current.canUndo(), canRedo: hist.current.canRedo(),
  }
  return { settings, hydrated, update, history }
}

/**
 * Settings live untuk konsumen yang jauh dari App: xterm di dalam node, dan wrapper editor di
 * `nodeTypes`. Dulu App menyuntikkannya ke `data` SETIAP node (`flowNodes`), yang punya dua
 * akibat buruk: identitas `data` baru untuk semua node pada tiap tick drag, dan — karena kedua
 * call site `TerminalCore` tidak pernah meneruskan prop `settings`-nya — tidak ada satu pun
 * setting terminal yang benar-benar sampai ke xterm. Context memotong perantaranya.
 *
 * Default `DEFAULT_SETTINGS` supaya komponen yang dites/dirender di luar provider tetap waras,
 * bukan meledak.
 */
const SettingsContext = createContext<Settings>(DEFAULT_SETTINGS)

export const SettingsProvider = SettingsContext.Provider

export function useLiveSettings(): Settings {
  return useContext(SettingsContext)
}
