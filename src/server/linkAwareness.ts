// Sisi PUSH untuk browser node yang DIKABEL ke sebuah agent node. `hookContext` mengumumkan peer
// context-link, tapi browser sengaja dikeluarkan dari roster itu (`buildLinkDoc`): browser bukan
// peer transcript, ia ALAT yang dikemudikan skill `webterm-browser`. Tanpa modul ini agent tidak
// pernah tahu kemampuan itu baru saja muncul / hilang sampai ia kebetulan memanggil skill-nya.
//
// Diff dihitung SAAT HOOK menyala terhadap set yang terakhir BENAR-BENAR diumumkan, bukan saat
// workspace disimpan: hasilnya sama (net effect antar dua prompt) dan otomatis meng-coalesce —
// kabel dipasang lalu dilepas sebelum prompt berikutnya = set sama = tidak ada pengumuman.
// Pola yang sama dengan memo signature `hookContext.nextHookContext`.
import type { Workspace } from '../shared/workspace'
import { BROWSER_KIND } from '../shared/browser.contract'
import { linkedPeerIds } from './contextLinkRoute'
import { BROWSER_SKILL_NAME } from './browserAgentShim'
import { createLogger } from './logs'

const log = createLogger('hooks')

export interface WiredBrowser { id: string; title: string }

const TITLE_MAX_CHARS = 120
// ponytail: daftar dipotong di 10 browser per pengumuman supaya teks ini + roster peer tetap di bawah
// cap 10k `additionalContext`; naikkan/hitung budget bersama bila canvas nyata punya >10 browser terkabel.
const MAX_LISTED = 10

/** Browser node yang terhubung kabel (arah mana pun) ke `nodeId`. */
export function linkedBrowsers(ws: Workspace, nodeId: string): WiredBrowser[] {
  const ids = linkedPeerIds(ws, nodeId)
  return ws.nodes
    .filter((n) => n.kind === BROWSER_KIND && ids.has(n.id))
    .map((n) => ({ id: n.id, title: n.title || n.id }))
}

/**
 * The agent's turn ended: hand its cabled browsers back so the user is not locked out until the lease
 * expires (the next agent action takes control again). Never throws: a hook reply must not fail for this.
 */
export function releaseCabledBrowsers(event: string | undefined, ws: Workspace, nodeId: string, release: (browserNodeId: string) => void): void {
  if (event !== 'Stop' && event !== 'StopFailure') return
  for (const browser of linkedBrowsers(ws, nodeId)) {
    try {
      release(browser.id)
    } catch (err) {
      log.warn('hooks.browser_release', 'Could not release browser lease at end of turn', { ids: { nodeId }, browserNodeId: browser.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** Judul = teks bebas user: satu baris, dipotong, dikutip sebagai DATA (lihat `peerLine` di hookContext). */
function label(b: WiredBrowser): string {
  const one = b.title.replace(/\s+/g, ' ').trim() || b.id
  const t = one.length > TITLE_MAX_CHARS ? `${one.slice(0, TITLE_MAX_CHARS)}…` : one
  return `"${t}" (id: ${b.id})`
}

function list(bs: WiredBrowser[]): string[] {
  const lines = bs.slice(0, MAX_LISTED).map((b) => `- browser node ${label(b)}`)
  if (bs.length > MAX_LISTED) lines.push(`(${bs.length - MAX_LISTED} more not listed.)`)
  return lines
}

// Pernyataan FAKTUAL, bukan perintah — alasan yang sama dengan `headline` di hookContext.
const CAN = `The ${BROWSER_SKILL_NAME} skill can drive a wired browser node (navigate, snapshot, click, type, screenshot); with several, pass --node <id>.`
const CANNOT = `The ${BROWSER_SKILL_NAME} skill can no longer drive it.`

/**
 * Pure. `prev` = set yang terakhir diumumkan (undefined = belum pernah). `SessionStart` mendaftar
 * set sekarang apa adanya (konteks lama hilang); `UserPromptSubmit` hanya mengumumkan PERUBAHAN.
 * Event lain → null (tidak punya kanal additionalContext).
 */
export function buildBrowserNotice(
  event: string | undefined, now: WiredBrowser[], prev: WiredBrowser[] | undefined,
): string | null {
  if (event === 'SessionStart') {
    if (!now.length) return null
    return ['Browser nodes wired to this webterm node by a canvas cable:', ...list(now), CAN].join('\n')
  }
  if (event !== 'UserPromptSubmit') return null
  const before = new Set((prev ?? []).map((b) => b.id))
  const nowIds = new Set(now.map((b) => b.id))
  const added = now.filter((b) => !before.has(b.id))
  const removed = (prev ?? []).filter((b) => !nowIds.has(b.id))
  const renamed = now.filter((b) => (prev ?? []).some((p) => p.id === b.id && p.title !== b.title))
  if (!added.length && !removed.length && !renamed.length) return null
  const out: string[] = []
  if (added.length) out.push('Since the last prompt, a canvas cable now wires this webterm node to:', ...list(added), CAN)
  if (removed.length) out.push('Since the last prompt, the cable to this webterm node was removed for:', ...list(removed), CANNOT)
  if (renamed.length) out.push('Since the last prompt, these wired browser nodes were renamed (current titles):', ...list(renamed))
  return out.join('\n')
}

/** Set terakhir yang diumumkan, per node. Hilang saat proses restart — sesi agent pun mati bersamanya. */
const lastAnnounced = new Map<string, WiredBrowser[]>()

/** Pembungkus ber-state: mengonsumsi notice node ini (sekali umumkan, lalu memo = set sekarang). */
export function nextBrowserNotice(nodeId: string, event: string | undefined, now: WiredBrowser[]): string | null {
  const text = buildBrowserNotice(event, now, lastAnnounced.get(nodeId))
  // Memo hanya maju pada event yang bisa mengumumkan; event lain tidak boleh "menelan" perubahan.
  if (event === 'SessionStart' || event === 'UserPromptSubmit') lastAnnounced.set(nodeId, now)
  return text
}

/** Catat `now` sebagai sudah diumumkan TANPA membangun teks — dipakai `linkNote` saat ia sudah
 *  mengetik pengumuman yang sama ke PTY, supaya `UserPromptSubmit` berikutnya tidak mengulangnya. */
export function markBrowsersAnnounced(nodeId: string, now: WiredBrowser[]): void {
  lastAnnounced.set(nodeId, now)
}

/** Lupakan memo sebuah node (node dihapus / sesi ditutup). */
export function forgetBrowserNotice(nodeId: string): void {
  lastAnnounced.delete(nodeId)
}
