// Verb baca agent: status, snapshot, screenshot, wait. Tidak butuh lease agent (hanya agentControl, dicek handler).
import { SCREENSHOT_MAX_BYTES, VIEWPORT_MAX, WAIT_MAX_MS } from '../../shared/browser.contract'
import { AGENT_CDP } from './browserAgent.cdpAllowlist'
import { buildSnapshot } from './browserAgent.snapshot'
import type { AxNode } from './browserAgent.snapshot'
import { asRecord, badRequest, domCall, stateOf } from './browserAgent.verbs.ctx'
import type { AgentCtx, AgentVerbs } from './browserAgent.verbs.ctx'
import { wrapUntrusted } from './browserAgent.wrap'
import { BrowserError } from './browserHost.targets'

const WAIT_POLL_MS = 100
/** Kualitas JPEG berturut-turut bila hasil melewati `SCREENSHOT_MAX_BYTES`. */
const SCREENSHOT_QUALITIES = [60, 30] as const
const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4)

interface Layout { cssVisualViewport?: { clientWidth?: number; clientHeight?: number }; cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }

/** Ukuran viewport CSS px dari `Page.getLayoutMetrics`. */
export async function viewportOf(ctx: AgentCtx, nodeId: string): Promise<{ w: number; h: number }> {
  const l = await domCall<Layout>(ctx, nodeId, AGENT_CDP.layout)
  const v = l.cssVisualViewport ?? l.cssLayoutViewport
  if (!v || !Number.isFinite(v.clientWidth) || !Number.isFinite(v.clientHeight)) throw new BrowserError('crashed', `node ${nodeId}: viewport size unavailable`)
  return { w: v.clientWidth as number, h: v.clientHeight as number }
}

/** Elemen punya kotak render (terlihat) bila `DOM.getContentQuads` mengembalikan kuad. */
async function isRendered(ctx: AgentCtx, nodeId: string, backendNodeId: number): Promise<boolean> {
  try {
    const r = await domCall<{ quads?: unknown[] }>(ctx, nodeId, AGENT_CDP.quads, { backendNodeId })
    return (r.quads?.length ?? 0) > 0
  } catch (err) {
    if (err instanceof BrowserError && err.code === 'stale_ref') return false
    throw err
  }
}

export function readVerbs(ctx: AgentCtx): Pick<AgentVerbs, 'status' | 'snapshot' | 'screenshot' | 'wait'> {
  return {
    async status(nodeId) {
      ctx.leases.touch(nodeId)
      return { ...stateOf(ctx, nodeId), lease: ctx.leases.holder(nodeId) }
    },

    async snapshot(nodeId) {
      stateOf(ctx, nodeId)
      ctx.leases.touch(nodeId)
      const tree = await domCall<{ nodes?: AxNode[] }>(ctx, nodeId, AGENT_CDP.axTree)
      const built = buildSnapshot(Array.isArray(tree.nodes) ? tree.nodes : [])
      const url = stateOf(ctx, nodeId).url
      const snapId = ctx.snapshots.save(nodeId, url, built.refs)
      return { snapId, content: wrapUntrusted(built.text), truncated: built.truncated, url }
    },

    async screenshot(nodeId, raw) {
      const body = asRecord(raw)
      stateOf(ctx, nodeId)
      ctx.leases.touch(nodeId)
      const mw = body.maxWidth
      if (mw !== undefined && !(Number.isInteger(mw) && (mw as number) >= 1 && (mw as number) <= VIEWPORT_MAX)) throw badRequest('maxWidth must be an integer within viewport limits')
      let clip: object | undefined
      if (mw !== undefined) {
        const vp = await viewportOf(ctx, nodeId)
        clip = { x: 0, y: 0, width: vp.w, height: vp.h, scale: Math.min(1, (mw as number) / vp.w) }
      }
      for (const quality of SCREENSHOT_QUALITIES) {
        const r = await domCall<{ data?: string }>(ctx, nodeId, AGENT_CDP.screenshot, { format: 'jpeg', quality, ...(clip ? { clip } : {}) })
        if (typeof r.data !== 'string') throw new BrowserError('crashed', `node ${nodeId}: screenshot returned no data`)
        if (b64Bytes(r.data) <= SCREENSHOT_MAX_BYTES) return { mime: 'image/jpeg', base64: r.data }
      }
      throw new BrowserError('too_large', `node ${nodeId}: screenshot exceeds ${SCREENSHOT_MAX_BYTES} bytes`)
    },

    // ponytail: batas waktu habis tetap `{ok:true}` (tipe kontrak); agent mengambil snapshot ulang untuk memeriksa hasilnya.
    async wait(nodeId, raw) {
      const body = asRecord(raw)
      stateOf(ctx, nodeId)
      ctx.leases.touch(nodeId)
      const { ms, selectorRef, loaded } = body
      if (ms !== undefined && !(Number.isInteger(ms) && (ms as number) >= 0 && (ms as number) <= WAIT_MAX_MS)) throw badRequest(`ms must be an integer within 0..${WAIT_MAX_MS}`)
      if (selectorRef !== undefined && (typeof selectorRef !== 'string' || !/^e\d+$/.test(selectorRef))) throw badRequest('selectorRef must look like e12')
      if (loaded !== undefined && loaded !== true) throw badRequest('loaded must be true')
      if (selectorRef === undefined && loaded === undefined) {
        await ctx.sleep((ms as number | undefined) ?? 0)
        return { ok: true }
      }
      const deadline = ctx.now() + ((ms as number | undefined) ?? WAIT_MAX_MS)
      const backendId = selectorRef === undefined ? undefined : ctx.snapshots.latest(nodeId, selectorRef as string)
      if (selectorRef !== undefined && backendId === undefined) throw new BrowserError('stale_ref', `node ${nodeId}: unknown ref ${selectorRef}`)
      for (;;) {
        const loadOk = loaded === undefined || !ctx.host.isLoading(nodeId)
        const refOk = backendId === undefined || (await isRendered(ctx, nodeId, backendId))
        if ((loadOk && refOk) || ctx.now() >= deadline) return { ok: true }
        await ctx.sleep(WAIT_POLL_MS)
      }
    },
  }
}
