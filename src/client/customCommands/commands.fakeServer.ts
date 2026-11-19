// test-only: a fake /api/custom-commands server (detect, paths, rescan) with the real error shape; records calls.
import { vi } from 'vitest'
import type { CustomCommandDetected } from '../../shared/customCommands'
import type { CommandPaths } from './commands.api'

export interface FakeCommands {
  calls: { url: string; method: string; body?: unknown }[]
  detected: CustomCommandDetected[]
  paths: CommandPaths
  /** Next N GETs of /detect answer 500. */
  loadFail: number
  /** Next POST /paths answers this status + error (400 = invalid_path_dir). */
  addError: { status: number; error: string; message: string } | null
  removeFail: boolean
  rescanAdded: number
  rescanFail: boolean
}

export const TOOL = (over: Partial<CustomCommandDetected> = {}): CustomCommandDetected => ({
  name: 'tool-a', path: '/home/u/.local/bin/tool-a', found: true, source: 'extra', format: 'elf', compat: 'ok', compatMessage: null, ...over,
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** Installs the fake as global `fetch`; the returned object is mutable state. */
export function fakeCommands(over: Partial<FakeCommands> = {}): FakeCommands {
  const s: FakeCommands = {
    calls: [], detected: [TOOL()], loadFail: 0, addError: null, removeFail: false, rescanAdded: 0, rescanFail: false,
    paths: { managed: '/data/custom-bin', platformDir: 'linux-amd64', extra: [], common: ['/home/u/.local/bin', '/usr/local/bin'], session: [] }, ...over,
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    s.calls.push({ url, method, body })
    if (url === '/api/custom-commands/detect') return s.loadFail-- > 0 ? json({ error: 'boom', message: 'detect crashed' }, 500) : json({ candidates: s.detected })
    if (url === '/api/custom-commands/paths' && method === 'GET') return json(s.paths)
    if (url === '/api/custom-commands/paths' && method === 'POST') {
      if (s.addError) return json({ error: s.addError.error, message: s.addError.message }, s.addError.status)
      const dir = (body as { dir: string }).dir
      s.paths = { ...s.paths, extra: [...s.paths.extra, { dir, exists: true, safe: true }], session: s.paths.session.filter((x) => x.dir !== dir) }
      return json(s.paths, 201)
    }
    if (url === '/api/custom-commands/paths/remove') {
      if (s.removeFail) return json({ error: 'write_failed', message: 'Could not write the folder list.' }, 500)
      s.paths = { ...s.paths, extra: s.paths.extra.filter((x) => x.dir !== (body as { dir: string }).dir) }
      return json(s.paths)
    }
    if (url === '/api/custom-commands/rescan') return s.rescanFail ? json({ error: 'write_failed', message: 'Scan failed.' }, 500) : json({ added: s.rescanAdded })
    return json({ error: 'not_found', message: 'unknown route' }, 404)
  }))
  return s
}
