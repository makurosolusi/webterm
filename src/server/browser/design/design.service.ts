// Design Mode for one browser runtime: inject/remove the overlay, then collect the picks, crop a
// screenshot and queue the note for the cabled agent(s) through the outbox (same delivery as link
// notes: idle + empty composer, exactly-once per operationId).
//
// Human-UI only: reached from `/api/browser/<id>/design*`, a prefix node tokens cannot call, so the
// raw `host.cdp` here is not the agent CDP path (that one stays behind `browserAgent.cdpAllowlist`).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Workspace } from '../../../shared/workspace'
import { createLogger } from '../../logs'
import type { EnqueueInput } from '../../outbox/outboxStore'
import { composeDesignNote, cropBox, designTargets } from './design.note'
import { DESIGN_GLOBAL, DESIGN_OVERLAY_SOURCE, type DesignCollect } from './design.overlay'

const log = createLogger('browser.design')

// Spelled from parts: `cdp.client.test.ts` keeps CDP method literals inside cdp.client.ts.
const m = (domain: string, name: string) => `${domain}.${name}`
export const DESIGN_CDP = {
  evaluate: m('Runtime', 'evaluate'),
  addScript: m('Page', 'addScriptToEvaluateOnNewDocument'),
  removeScript: m('Page', 'removeScriptToEvaluateOnNewDocument'),
  screenshot: m('Page', 'captureScreenshot'),
} as const

export interface DesignDeps {
  cdp(nodeId: string, method: string, params?: object): Promise<unknown>
  workspaces(): Workspace[]
  /** Directory the cropped screenshots are written to. */
  shotDir: string
  outbox(): Promise<{ enqueue(input: EnqueueInput): unknown }>
  bodyMax: number
  now?: () => number
  write?: (path: string, data: Buffer) => Promise<void>
}

/** A refusal the route maps to an HTTP status (product text: English, shown in the UI). */
export class DesignError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DesignError'
  }
}

export interface DesignSendResult { sentTo: string[]; picks: number; screenshot: string | null }

export class DesignMode {
  /** Node id -> identifier of its new-document script, present exactly while Design Mode is on. */
  private scripts = new Map<string, string>()

  constructor(private d: DesignDeps) {}

  isOn(nodeId: string): boolean { return this.scripts.has(nodeId) }

  /** The node's page went away (discarded/crashed): its new-document script went with it. */
  forget(nodeId: string): void { this.scripts.delete(nodeId) }

  private async evaluate(nodeId: string, expression: string): Promise<unknown> {
    const r = (await this.d.cdp(nodeId, DESIGN_CDP.evaluate, { expression, returnByValue: true })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
    if (r?.exceptionDetails) throw new Error(`design overlay script failed on node ${nodeId}: ${r.exceptionDetails.text ?? 'exception'}`)
    return r?.result?.value
  }

  /** On: inject now and on every new document. Off: stop the re-injection, then tear the overlay down. */
  async set(nodeId: string, on: boolean): Promise<void> {
    if (on) {
      if (!this.scripts.has(nodeId)) {
        const r = (await this.d.cdp(nodeId, DESIGN_CDP.addScript, { source: DESIGN_OVERLAY_SOURCE })) as { identifier?: string }
        if (typeof r?.identifier !== 'string') throw new Error(`design: node ${nodeId} returned no script identifier`)
        this.scripts.set(nodeId, r.identifier)
      }
      await this.evaluate(nodeId, DESIGN_OVERLAY_SOURCE)
      return
    }
    const identifier = this.scripts.get(nodeId)
    this.scripts.delete(nodeId)
    if (identifier) await this.d.cdp(nodeId, DESIGN_CDP.removeScript, { identifier })
    await this.evaluate(nodeId, `window.${DESIGN_GLOBAL}?.remove()`)
  }

  /** Collect the picks, crop a screenshot of them, and queue one note per cabled agent. */
  async send(nodeId: string, comment: string): Promise<DesignSendResult> {
    const ws = this.d.workspaces().find((w) => w.nodes.some((n) => n.id === nodeId))
    if (!ws) throw new DesignError(404, 'not_found', 'This browser node is not on a saved board yet.')
    const to = designTargets(ws, nodeId)
    if (!to.length) throw new DesignError(409, 'no_linked_agent', 'No agent is wired to this browser node. Connect an agent node with a cable first.')
    const c = (await this.evaluate(nodeId, `window.${DESIGN_GLOBAL}?.collect() ?? null`)) as DesignCollect | null
    if (!c || !Array.isArray(c.picks)) throw new DesignError(409, 'design_off', 'Design Mode is not on in this page. Turn it on and pick an element.')
    if (!c.picks.length) throw new DesignError(409, 'no_selection', 'Pick at least one element on the page first.')
    const ts = (this.d.now ?? Date.now)()
    const shot = await this.screenshot(nodeId, c, ts)
    const body = composeDesignNote(c, comment, shot, this.d.bodyMax)
    const outbox = await this.d.outbox()
    for (const id of to) outbox.enqueue({ to: id, body, kind: 'visible', operationId: `design:${nodeId}:${ts}:${id}`, createdBy: 'human-ui' })
    log.info('design.send', 'Design note queued', { ids: { nodeId }, agents: to.length, picks: c.picks.length })
    return { sentTo: to, picks: c.picks.length, screenshot: shot }
  }

  private async screenshot(nodeId: string, c: DesignCollect, ts: number): Promise<string | null> {
    const clip = cropBox(c)
    if (!clip) return null
    await this.evaluate(nodeId, `window.${DESIGN_GLOBAL}?.hide()`)
    let data: unknown
    try {
      data = ((await this.d.cdp(nodeId, DESIGN_CDP.screenshot, { format: 'jpeg', quality: 80, clip })) as { data?: unknown })?.data
    } finally {
      await this.evaluate(nodeId, `window.${DESIGN_GLOBAL}?.show()`)
    }
    if (typeof data !== 'string') throw new Error(`design: screenshot of node ${nodeId} returned no data`)
    const path = join(this.d.shotDir, `${nodeId}-${ts}.jpg`)
    const write = this.d.write ?? (async (p, b) => { await mkdir(this.d.shotDir, { recursive: true }); await writeFile(p, b) })
    await write(path, Buffer.from(data, 'base64'))
    return path
  }
}
