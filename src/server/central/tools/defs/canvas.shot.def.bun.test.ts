import { describe, expect, test } from 'bun:test'
import { freshDb, rows } from '../../guard/controlGuard.testutil'
import { ALLOW_ALL_GUARD, execTool, execToolReceipt } from '../toolExec'
import { toolProblems } from '../toolCapability'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import type { ShotResult } from '../../../canvas/shotBroker'
import { createCanvasShotDefs, createCanvasShotDefsWith, SHOT_DEFAULT_WIDTH } from './canvas.shot.def'
import { READ_TOOLS_FLAG } from './read.shared'

const B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]).toString('base64') // test-only

function harness(answer: ShotResult = { ok: true, mimeType: 'image/jpeg', data: B64 }) {
  const widths: number[] = []
  const registry = createRegistry()
  createCanvasShotDefsWith({ shoot: async (w) => { widths.push(w); return answer } }).forEach((d) => registry.register(d))
  const db = freshDb()
  const ctx: ToolCtx = { db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId: 'central:global', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
  return { ctx, db, widths }
}

describe('canvas.screenshot def', () => {
  test('is a well-formed global R0 read behind the read-tools flag (production factory too)', () => {
    const [def] = createCanvasShotDefs()
    expect(def).toMatchObject({ name: 'canvas.screenshot', tier: 'R0', flag: READ_TOOLS_FLAG, projectScoped: false })
    expect(toolProblems(def!)).toEqual([])
    expect(def!.auditKeys).not.toContain('image')
  })

  test('returns the image with mimeType and decoded byte count; default width 1600', async () => {
    const { ctx, widths } = harness()
    const r = await execTool(ctx, 'canvas.screenshot', {})
    expect(r).toMatchObject({ ok: true, data: { mimeType: 'image/jpeg', bytes: 64, image: { mimeType: 'image/jpeg', data: B64 } } })
    expect(widths).toEqual([SHOT_DEFAULT_WIDTH])
  })

  test('maxWidth is an integer 320..2560; other keys are refused', async () => {
    const { ctx, widths } = harness()
    expect((await execTool(ctx, 'canvas.screenshot', { maxWidth: 320 })).ok).toBe(true)
    expect((await execTool(ctx, 'canvas.screenshot', { maxWidth: 2560 })).ok).toBe(true)
    for (const bad of [{ maxWidth: 319 }, { maxWidth: 2561 }, { maxWidth: 800.5 }, { maxWidth: '800' }, { other: 1 }]) {
      expect((await execTool(ctx, 'canvas.screenshot', bad)).code).toBe('invalid_shape')
    }
    expect(widths).toEqual([320, 2560])
  })

  test('no visible window: a coded failure with a hint the model can act on', async () => {
    const { ctx } = harness({ ok: false, code: 'no_visible_window' })
    const r = await execTool(ctx, 'canvas.screenshot', {})
    expect(r.ok).toBe(false)
    expect(r.code).toBe('no_visible_window')
    expect(String(r.data?.hint)).toContain('webterm')
  })

  test('the audit event and the receipt carry no base64', async () => {
    const { ctx, db } = harness()
    const { receipt, result } = await execToolReceipt(ctx, 'canvas.screenshot', { maxWidth: 1024 })
    expect(result?.data?.image).toBeDefined() // the caller (MCP projection) still gets it
    expect(JSON.stringify(receipt)).not.toContain(B64)
    const audit = rows(db, "SELECT payload_json FROM event WHERE kind = 'central.proposal'")
    expect(audit.length).toBe(1)
    expect(JSON.stringify(audit)).not.toContain(B64)
    expect(JSON.parse(String(audit[0]!.payload_json))).toMatchObject({ tool: 'canvas.screenshot', ok: true, mimeType: 'image/jpeg', bytes: 64 })
  })
})
