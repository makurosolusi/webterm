// canvas.screenshot (R0): an image of what the user sees in the webterm window right now. Central runs
// with `tools: []` (no Read), so the image travels back as the receipt's `data.image`, which the MCP
// projection turns into an image content block (mcp.protocol.ts). The base64 is never audited
// (auditKeys) and never reaches the receipt (toReceipt keeps data key names only).
import { obj, S } from '../../../capability/capability.schema'
import type { ShotResult } from '../../../canvas/shotBroker'
import type { ToolDef, ToolResult } from '../toolTypes'
import { READ_TOOLS_FLAG } from './read.shared'

export const SHOT_MIN_WIDTH = 320
export const SHOT_MAX_WIDTH = 2560
export const SHOT_DEFAULT_WIDTH = 1600

export interface CanvasShotDeps { shoot(maxWidth: number): Promise<ShotResult> }

const HINTS: Record<string, string> = {
  no_visible_window: 'No webterm window answered: the user has no visible webterm tab. Ask them to open webterm, then retry.',
  busy: 'Other screenshots are still running; retry in a few seconds.',
}

/** Builds canvas.screenshot over an injected capture (tests pass a fake). */
export function createCanvasShotDefsWith(deps: CanvasShotDeps): ToolDef[] {
  const shot: ToolDef = {
    name: 'canvas.screenshot',
    summary: 'Screenshot of what the user sees in the webterm window right now; call canvas.show first to look at another workspace.',
    tier: 'R0',
    flag: READ_TOOLS_FLAG,
    projectScoped: false,
    usage: `{"maxWidth":<${SHOT_MIN_WIDTH}-${SHOT_MAX_WIDTH}, default ${SHOT_DEFAULT_WIDTH}>}. Returns the image of the visible webterm tab. `
      + 'Fails with no_visible_window when no webterm tab is open and visible.',
    input: obj({ maxWidth: S.int(SHOT_MIN_WIDTH, SHOT_MAX_WIDTH) }),
    output: S.keys('mimeType', 'bytes', 'image'),
    auditKeys: ['mimeType', 'bytes'],
    validate: (input) => (Object.keys(input).every((k) => k === 'maxWidth') ? null : 'invalid_shape'),
    async handler(_ctx, input): Promise<ToolResult> {
      const r = await deps.shoot((input.maxWidth as number | undefined) ?? SHOT_DEFAULT_WIDTH)
      if (!r.ok) return { ok: false, code: r.code, ...(HINTS[r.code] ? { data: { hint: HINTS[r.code] } } : {}) }
      return { ok: true, data: { mimeType: r.mimeType, bytes: Buffer.byteLength(r.data, 'base64'), image: { mimeType: r.mimeType, data: r.data } } }
    },
  }
  return [shot]
}

/** Production wiring: the process-wide shot broker, loaded on first call. */
export function createCanvasShotDefs(): ToolDef[] {
  return createCanvasShotDefsWith({ shoot: async (w) => (await import('../../../canvas/shotBroker')).getShotBroker().request(w) })
}
