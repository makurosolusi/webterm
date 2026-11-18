// Siklus hidup target: koneksi CDP per workspace, buka/buka-ulang target node, discard, crash, dispose.
// Dipisah dari `browserHost.service.ts` (Rule 8); efek ke state/event lewat `LifecycleOps` yang disediakan host.
import type { BrowserState } from '../../shared/browser.contract'
import { createLogger } from '../logs'
import { CDP, CDP_EVENT, CdpClient } from './cdp.client'
import type { CdpHandler } from './cdp.client'
import { LaunchError } from './chromium.launch'
import type { BrowserLauncher } from './chromium.launch'
import { restoreDevice, type DeviceIo } from './browserHost.device'
import type { ShieldRouter } from './browserHost.shield'
import type { ConsoleLog } from './browserHost.console'
import { blockOf, BrowserError, createPageTarget, newRec, setupConnection } from './browserHost.targets'
import type { HostEvent, NavGuard, NodeRec, TargetTable } from './browserHost.targets'

const log = createLogger('browser.host')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface LifecycleOps {
  table: TargetTable
  launcher: BrowserLauncher
  /** Profile of a node (the single `resolveProfileId` rule, applied to the live board); default = the workspace's Default profile. */
  profileOf?: (nodeId: string, workspaceId: string) => string
  guard: NavGuard
  connect?: (wsUrl: string) => Promise<CdpClient>
  initialDevice?: (nodeId: string) => unknown
  shield: ShieldRouter
  console: ConsoleLog
  route: CdpHandler
  patch(rec: NodeRec, part: Partial<BrowserState>): void
  emit(e: HostEvent): void
  io(rec: NodeRec): DeviceIo
  goto(rec: NodeRec, url: string): Promise<void>
}

export interface TargetLifecycle {
  /** Buka (atau pulihkan) target node; panggilan paralel untuk node yang sama berbagi satu janji. */
  open(nodeId: string, workspaceId: string, url?: string): Promise<BrowserState>
  /** Tutup target node tanpa melupakan node (state `discarded`). */
  discard(nodeId: string): Promise<void>
  /** Target hilang (crash/putus): lepas ikatan dan laporkan galat `crashed`. */
  crash(rec: NodeRec): void
  /** Koneksi CDP hidup milik workspace node; `crashed` bila sudah putus. */
  cdpOf(rec: NodeRec): Promise<CdpClient>
  /** Tutup semua koneksi CDP (proses Chromium dimatikan oleh `launcher.shutdown()`). */
  dispose(): Promise<void>
}

/** Pembuat pengelola koneksi CDP + target node untuk satu host. */
export function createTargetLifecycle(ops: LifecycleOps): TargetLifecycle {
  const { table } = ops
  const conns = new Map<string, Promise<CdpClient>>()
  const opening = new Map<string, Promise<BrowserState>>()

  const crash = (rec: NodeRec): void => {
    if (!rec.sessionId) return
    ops.shield.forget(rec)
    table.unbind(rec)
    ops.patch(rec, { live: 'discarded', loading: false })
    ops.emit({ k: 'error', nodeId: rec.nodeId, code: 'crashed' })
    log.warn('browser.crash', 'browser target lost', { ids: { nodeId: rec.nodeId } })
  }

  const onConnClosed = (profileId: string, err: Error): void => {
    conns.delete(profileId)
    log.warn('browser.conn', 'cdp connection closed', { ids: { profileId }, error: err.message })
    for (const rec of table.nodes.values()) if (rec.profileId === profileId) crash(rec)
  }

  const connection = (profileId: string): Promise<CdpClient> => {
    let p = conns.get(profileId)
    if (!p) {
      p = (async () => {
        const wsUrl = await ops.launcher.acquire(profileId)
        const cdp = await (ops.connect ?? ((u: string) => CdpClient.connect(u)))(wsUrl)
        cdp.on('*', ops.route)
        cdp.on('*', ops.console.route)
        cdp.on(CDP_EVENT.requestPaused, (p, sid) => ops.shield.paused(cdp, p, sid))
        cdp.on(CDP_EVENT.attachedToTarget, (p, sid) => ops.shield.attached(cdp, p, sid))
        cdp.onClose((err) => onConnClosed(profileId, err))
        try {
          await setupConnection(cdp)
        } catch (err) {
          cdp.close()
          throw err
        }
        return cdp
      })()
      conns.set(profileId, p)
      p.catch(() => conns.delete(profileId)) // lemparan tetap sampai ke pemanggil connection()
    }
    return p
  }

  const doOpen = async (nodeId: string, workspaceId: string, url?: string): Promise<BrowserState> => {
    let rec = table.nodes.get(nodeId)
    if (rec?.sessionId) return { ...rec.state }
    if (!rec) table.nodes.set(nodeId, (rec = newRec(nodeId, workspaceId, url ?? '')))
    rec.workspaceId = workspaceId
    const profileId = ops.profileOf?.(nodeId, workspaceId) ?? workspaceId
    rec.profileId = profileId
    const target = url ?? rec.state.url
    const blocked = target ? blockOf(ops.guard, target) : null
    let cdp: CdpClient
    try {
      cdp = await connection(profileId)
    } catch (err) {
      const noBin = err instanceof LaunchError && err.code === 'no_binary'
      if (noBin) ops.patch(rec, { blocked: 'no_binary' })
      // Without this line a failed launch left only a stream of info "chromium exited" in the log.
      else log.warn('browser.launch_failed', 'browser could not start for this node', {
        ids: { workspaceId, profileId, nodeId }, code: err instanceof LaunchError ? err.code : err instanceof Error ? err.name : typeof err,
      })
      throw new BrowserError(noBin ? 'no_binary' : 'launch_failed', `open node ${nodeId} failed: ${errMsg(err)}`, undefined, err)
    }
    const { targetId, sessionId } = await createPageTarget(cdp, rec.viewport)
    table.bind(rec, targetId, sessionId)
    await restoreDevice(rec, () => ops.initialDevice?.(nodeId), ops.io(rec))
    await ops.shield.enable(cdp, sessionId)
    await ops.console.enable(cdp, sessionId)
    ops.patch(rec, { live: 'live', blocked: blocked?.reason, url: target, ...ops.shield.pageState(target) })
    if (target && !blocked) await ops.goto(rec, target)
    return { ...rec.state }
  }

  return {
    crash,
    open(nodeId, workspaceId, url) {
      const inflight = opening.get(nodeId)
      if (inflight) return inflight
      const p = doOpen(nodeId, workspaceId, url).finally(() => opening.delete(nodeId))
      opening.set(nodeId, p)
      return p
    },
    async discard(nodeId) {
      const rec = table.nodes.get(nodeId)
      if (!rec?.sessionId) return
      const targetId = rec.targetId as string
      const cdp = await conns.get(rec.profileId)
      ops.shield.forget(rec)
      table.unbind(rec) // unbind dulu: targetDestroyed berikutnya bukan crash
      ops.patch(rec, { live: 'discarded', loading: false })
      try {
        await cdp?.send(CDP.closeTarget, { targetId })
      } catch (err) {
        log.warn('browser.discard', 'closeTarget failed (target may already be gone)', { ids: { nodeId }, error: errMsg(err) })
      }
    },
    async cdpOf(rec) {
      const cdp = await conns.get(rec.profileId)
      if (!cdp || cdp.closed) throw new BrowserError('crashed', `node ${rec.nodeId}: browser connection is gone`)
      return cdp
    },
    async dispose() {
      const all = [...conns.values()]
      conns.clear()
      for (const p of all) (await p.catch(() => null))?.close() // koneksi yang gagal dibuat tidak perlu ditutup
    },
  }
}
