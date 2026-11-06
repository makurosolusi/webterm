// Small one-off routes: AI name generation and the server-side folder picker.
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import npath from 'node:path'
import { json, type ApiRoute } from './route.core'
import { uiOnly } from './route.uiOnly'
import { BodyReadError } from '../cappedRequestBody'

/** `{"node": "<id>"}` is tens of bytes; 4 KiB leaves room without buffering junk. */
const GENERATE_NAME_BODY_MAX = 4 * 1024
const BAD_NODE = 'Expected a JSON body {"node": "<id>"}.'

export const miscRoutes: ApiRoute[] = [
  // AI name-gen: spawn claude -p on a node's terminal buffer, return a suggested title. POST + UI-only
  // (sec-208-10): it spends model tokens and reads a node's terminal, so a cross-site <img> or a local
  // curl must not trigger it; a GET was both cacheable and fireable by any page.
  uiOnly({
    name: 'generate-name',
    match: (c) => c.path === '/api/generate-name' && c.method === 'POST',
    handle: async (c) => {
      let node: unknown
      try {
        node = (JSON.parse(await c.body(GENERATE_NAME_BODY_MAX)()) as { node?: unknown } | null)?.node
      } catch (err) {
        if (err instanceof BodyReadError && err.reason === 'too_large') json(c.res, 413, { error: 'payload_too_large', message: 'Request body is too large.' })
        else if (err instanceof BodyReadError || err instanceof SyntaxError) json(c.res, 400, { error: 'bad_body', message: BAD_NODE })
        else throw err
        return true
      }
      if (typeof node !== 'string' || node === '') {
        json(c.res, 400, { error: 'bad_node', message: BAD_NODE })
        return true
      }
      const { generateName } = await import('../nameGen')
      json(c.res, 200, await generateName(node))
      return true
    },
  }),
  // Server-side folder picker: list subdirectories of a dir (dotfiles hidden). UI-only (route.uiOnly.ts).
  uiOnly({
    name: 'folder-picker',
    match: (c) => c.path === '/api/fs' && c.method === 'GET',
    handle: async (c) => {
      const dir = c.url.searchParams.get('path') || homedir()
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
        const parent = npath.dirname(dir)
        json(c.res, 200, { path: dir, parent: parent === dir ? null : parent, dirs })
      } catch (e) {
        json(c.res, 404, { error: 'cannot read dir', code: (e as NodeJS.ErrnoException).code ?? null })
      }
      return true
    },
  }),
]
