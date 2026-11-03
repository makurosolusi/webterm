// Verb aksi agent: navigate, click, type, press, scroll. Semuanya wajib lease agent (`lease_human` bila tidak).
// Input disalurkan lewat `host.input` (bertipe), navigasi lewat `host.navigate` (penjaga SSRF); CDP generik hanya via allowlist.
import { URL_MAX_CHARS } from '../../shared/browser.contract'
import type { BrowserInputEvent, MouseInput } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { AGENT_CDP } from './browserAgent.cdpAllowlist'
import { asRecord, badRequest, domCall, needString, stateOf } from './browserAgent.verbs.ctx'
import type { AgentCtx, AgentVerbs } from './browserAgent.verbs.ctx'
import { viewportOf } from './browserAgent.verbs.read'
import { BrowserError } from './browserHost.targets'

const REF_RE = /^e\d+$/
const SCROLL_MAX_PX = 10_000
const KEYS: Record<string, { code: string; vk: number; text: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9, text: '' }, Escape: { code: 'Escape', vk: 27, text: '' },
  Backspace: { code: 'Backspace', vk: 8, text: '' }, Delete: { code: 'Delete', vk: 46, text: '' }, ' ': { code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38, text: '' }, ArrowDown: { code: 'ArrowDown', vk: 40, text: '' },
  ArrowLeft: { code: 'ArrowLeft', vk: 37, text: '' }, ArrowRight: { code: 'ArrowRight', vk: 39, text: '' },
  PageUp: { code: 'PageUp', vk: 33, text: '' }, PageDown: { code: 'PageDown', vk: 34, text: '' },
  Home: { code: 'Home', vk: 36, text: '' }, End: { code: 'End', vk: 35, text: '' },
}

const mouse = (type: MouseInput['type'], x: number, y: number, buttons: number, extra: Partial<MouseInput> = {}): MouseInput => ({
  t: 'mouse', type, x, y, button: type === 'move' || type === 'wheel' ? 'none' : 'left', buttons, clickCount: type === 'move' || type === 'wheel' ? 0 : 1, mods: 0, dx: 0, dy: 0, ...extra,
})

function refBody(raw: unknown): { ref: string; snapId: string; body: Record<string, unknown> } {
  const body = asRecord(raw)
  const ref = needString(body.ref, 'ref', 16)
  if (!REF_RE.test(ref)) throw badRequest('ref must look like e12')
  return { ref, snapId: needString(body.snapId, 'snapId', 32), body }
}

/** Bawa elemen ke viewport dan hitung titik tengah kuad pertamanya (koordinat halaman). */
async function centerOf(ctx: AgentCtx, nodeId: string, backendNodeId: number): Promise<{ x: number; y: number }> {
  await domCall(ctx, nodeId, AGENT_CDP.scrollIntoView, { backendNodeId })
  const { quads } = await domCall<{ quads?: number[][] }>(ctx, nodeId, AGENT_CDP.quads, { backendNodeId })
  const q = quads?.[0]
  if (!q || q.length < 8 || !q.slice(0, 8).every(Number.isFinite)) throw new BrowserError('stale_ref', `node ${nodeId}: element has no visible box`)
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
}

async function pressKey(ctx: AgentCtx, nodeId: string, key: string): Promise<void> {
  const k = KEYS[key]
  if (!Object.hasOwn(KEYS, key)) throw badRequest(`unsupported key; use one of: ${Object.keys(KEYS).join(', ')}`)
  const base = { t: 'key', key, code: k.code, text: k.text, vk: k.vk, mods: 0 } as const
  await ctx.host.input(nodeId, { ...base, type: 'down' })
  await ctx.host.input(nodeId, { ...base, type: 'up' })
}

/**
 * P-10: tombol dengan `formaction` ke origin lain = pengiriman lintas-origin, butuh persetujuan manusia (absen = ditolak).
 * ponytail: hanya `formaction` pada elemen yang diklik; `action` pada <form> induk belum terdeteksi (butuh pohon DOM), tambah bila perlu.
 */
async function gateCrossOrigin(ctx: AgentCtx, nodeId: string, backendNodeId: number): Promise<void> {
  const { node } = await domCall<{ node?: { attributes?: string[] } }>(ctx, nodeId, AGENT_CDP.describe, { backendNodeId })
  const attrs = node?.attributes ?? []
  const at = attrs.findIndex((a, i) => i % 2 === 0 && a.toLowerCase() === 'formaction')
  if (at < 0) return
  let target: URL
  const pageUrl = stateOf(ctx, nodeId).url
  try {
    target = new URL(attrs[at + 1], pageUrl)
  } catch (err) {
    throw new BrowserError('blocked', `node ${nodeId}: unparseable formaction`, undefined, err)
  }
  if (target.origin === new URL(pageUrl).origin) return
  const hostname = hostOnly(target.href)
  if (!(await ctx.approve?.({ nodeId, verb: 'click', hostname }))) {
    throw new BrowserError('blocked', `node ${nodeId}: cross-origin submit to ${hostname} needs human approval`, hostname)
  }
}

export function actVerbs(ctx: AgentCtx): Pick<AgentVerbs, 'navigate' | 'click' | 'type' | 'press' | 'scroll'> {
  const input = (nodeId: string, ev: BrowserInputEvent) => ctx.host.input(nodeId, ev)
  return {
    async navigate(nodeId, raw) {
      const url = needString(asRecord(raw).url, 'url', URL_MAX_CHARS)
      stateOf(ctx, nodeId)
      ctx.leases.requireAgent(nodeId)
      await ctx.host.navigate(nodeId, url) // BlockedError -> 403 di handler
      ctx.snapshots.drop(nodeId)
      return { ok: true }
    },

    async click(nodeId, raw) {
      const { ref, snapId } = refBody(raw)
      const s = stateOf(ctx, nodeId)
      ctx.leases.requireAgent(nodeId)
      const target = ctx.snapshots.resolve(nodeId, snapId, ref, s.url)
      await gateCrossOrigin(ctx, nodeId, target)
      const { x, y } = await centerOf(ctx, nodeId, target)
      await input(nodeId, mouse('move', x, y, 0))
      await input(nodeId, mouse('down', x, y, 1))
      await input(nodeId, mouse('up', x, y, 0))
      return { ok: true }
    },

    // ponytail: teks disisipkan di posisi caret (tidak menimpa isi lama); tambah select-all bila agent butuh mengganti nilai.
    async type(nodeId, raw) {
      const { ref, snapId, body } = refBody(raw)
      const text = needString(body.text, 'text')
      if (body.submit !== undefined && typeof body.submit !== 'boolean') throw badRequest('submit must be boolean')
      const s = stateOf(ctx, nodeId)
      ctx.leases.requireAgent(nodeId)
      const target = ctx.snapshots.resolve(nodeId, snapId, ref, s.url)
      await domCall(ctx, nodeId, AGENT_CDP.scrollIntoView, { backendNodeId: target })
      await domCall(ctx, nodeId, AGENT_CDP.focus, { backendNodeId: target })
      await input(nodeId, { t: 'text', text })
      if (body.submit === true) await pressKey(ctx, nodeId, 'Enter')
      return { ok: true }
    },

    async press(nodeId, raw) {
      const key = needString(asRecord(raw).key, 'key', 16)
      stateOf(ctx, nodeId)
      ctx.leases.requireAgent(nodeId)
      await pressKey(ctx, nodeId, key)
      return { ok: true }
    },

    async scroll(nodeId, raw) {
      const dy = asRecord(raw).dy
      if (typeof dy !== 'number' || !Number.isFinite(dy) || dy === 0 || Math.abs(dy) > SCROLL_MAX_PX) throw badRequest(`dy must be a non-zero number within ±${SCROLL_MAX_PX}`)
      stateOf(ctx, nodeId)
      ctx.leases.requireAgent(nodeId)
      const vp = await viewportOf(ctx, nodeId)
      await input(nodeId, mouse('wheel', vp.w / 2, vp.h / 2, 0, { dy }))
      return { ok: true }
    },
  }
}
