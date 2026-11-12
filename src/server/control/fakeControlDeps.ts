// Deps palsu untuk test control API. Capability memakai implementasi NYATA (`CapabilityStore` +
// `allows`) supaya matriks scope/expiry menguji modul yang dipakai produksi; hanya PTY dan waktu
// yang dipalsukan. Dipisah dari file test supaya tiap file test tetap di bawah batas baris.

import { mergeSettings } from '../../shared/settings'
import type { OpenMsg } from '../../shared/protocol'
import type { AgentStatus } from '../../shared/workspace'
import { CapabilityStore, allows, clampTtl, type CapabilityVerb } from './capabilities'
import { handleControl } from './controlApi'
import type { ControlDeps, ControlExit, ControlSessionInfo } from './controlTypes'

interface FakeNode {
  status?: AgentStatus
  exit?: ControlExit
  output: string
}

export function harness(overrides: Partial<ControlDeps> = {}) {
  const clock = { t: 1_000_000 }
  const live = new Map<string, FakeNode>()
  const opened: OpenMsg[] = []
  const inputs: { id: string; data: string }[] = []
  const closed: string[] = []
  const store = new CapabilityStore()

  const deps: ControlDeps = {
    sessions: {
      open(msg) {
        opened.push(msg)
        live.set(msg.id, { output: '' })
      },
      input(id, data) {
        inputs.push({ id, data })
      },
      close(id) {
        closed.push(id)
        live.delete(id)
      },
      list(): ControlSessionInfo[] {
        return [...live.entries()].map(([id, node], i) => ({ id, pid: i + 1, status: node.status }))
      },
      statusOf(id) {
        return live.get(id)?.status
      },
      getExit(id) {
        return live.get(id)?.exit
      },
      getTerminal(id) {
        return live.get(id)?.output ?? ''
      },
      isLive(id) {
        return live.has(id)
      },
      // Plain-shell submit path (one write); the confirmed Claude path is covered by agentSubmit.test.ts.
      screenSource: () => undefined,
      agentIdOf: () => undefined,
    },
    capabilities: {
      verify: (token, now = clock.t) => store.verify(token, now),
      allows,
      mint: (opts) => ({
        token: store.mint(opts, clock.t),
        expiresAt: clock.t + clampTtl(opts.ttlMs),
      }),
    },
    settings: () => mergeSettings({ agentLaunchCommands: { claude: 'claude-work' } }),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms
    },
    ...overrides,
  }

  const token = (verb: CapabilityVerb, resource: string, ttlMs?: number) =>
    store.mint({ verb, resource, ...(ttlMs === undefined ? {} : { ttlMs }) }, clock.t)
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handleControl(
      { method, path: `/api/control/${path}`, headers, ...(body === undefined ? {} : { body }) },
      deps
    )

  return { deps, live, opened, inputs, closed, clock, token, call }
}

export const spawnBody = (requestId = 'req-0001', nodeId = 'node-a') => ({
  requestId,
  nodeId,
  agentId: 'claude',
})
