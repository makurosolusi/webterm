// Small one-off routes: AI name generation and the server-side folder picker.
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import npath from 'node:path'
import { json, type ApiRoute } from './route.core'

export const miscRoutes: ApiRoute[] = [
  // AI name-gen: spawn claude -p on a node's terminal buffer, return a suggested title.
  {
    name: 'generate-name',
    match: (c) => c.path === '/api/generate-name' && c.method === 'GET',
    handle: async (c) => {
      const node = c.url.searchParams.get('node') || ''
      const { generateName } = await import('../nameGen')
      json(c.res, 200, await generateName(node))
      return true
    },
  },
  // Server-side folder picker: list subdirectories of a dir (dotfiles hidden).
  {
    name: 'folder-picker',
    match: (c) => c.path === '/api/fs' && c.method === 'GET',
    handle: async (c) => {
      const dir = c.url.searchParams.get('path') || homedir()
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
        const parent = npath.dirname(dir)
        json(c.res, 200, { path: dir, parent: parent === dir ? null : parent, dirs })
      } catch {
        json(c.res, 404, { error: 'cannot read dir' })
      }
      return true
    },
  },
]
