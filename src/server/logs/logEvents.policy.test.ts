// Scanner: every log event name written in server sources is `domain.subdomain_action` (lowercase, digits, `_`),
// and the correlation ids use the standard keys. Old names that predate the convention are listed by name below:
// fix one and delete it from the list; never add to it.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const EVENT_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const ID_KEYS = new Set(['workspaceId', 'profileId', 'nodeId', 'sessionId', 'requestId'])
/** Event names that predate the convention (kebab/camel case); frozen. */
const LEGACY_EVENTS = new Set([
  'canvas-background.gc_failed', 'canvas-background.prune_failed', 'canvas-background.serve_failed', 'canvas-background.upload',
  'fs.trash-sweep', 'linkNote.delivered', 'linkNote.tick', 'settings.customAgents.dropped',
])
const CALL = /\b(?:log|logger|[a-zA-Z]*Log)\.(?:info|warn|error|debug|trace)\(\s*'([a-zA-Z0-9_.-]+)'/g
const IDS_BAG = /\bids:\s*\{([^}]*)\}/g

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.ts$/.test(e.name) && !/\.test\.ts$|\.testkit\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
}

const root = join(__dirname, '..')
const files = sources(root).map((file) => ({ file, text: readFileSync(file, 'utf8') }))

describe('log event convention', () => {
  it('scans a real set of call sites', () => {
    const count = files.reduce((n, f) => n + [...f.text.matchAll(CALL)].length, 0)
    expect(count).toBeGreaterThan(200)
  })

  it('event names are domain.subdomain_action, except the named legacy ones', () => {
    const bad = new Set<string>()
    for (const f of files) for (const m of f.text.matchAll(CALL)) if (!EVENT_FORMAT.test(m[1]) && !LEGACY_EVENTS.has(m[1])) bad.add(`${m[1]} (${f.file.slice(root.length + 1)})`)
    expect([...bad]).toEqual([])
  })

  it('every legacy exception still exists (delete it from the list once fixed)', () => {
    const all = new Set(files.flatMap((f) => [...f.text.matchAll(CALL)].map((m) => m[1])))
    expect([...LEGACY_EVENTS].filter((e) => !all.has(e))).toEqual([])
  })

  it('correlation ids use the standard keys', () => {
    const bad = new Set<string>()
    for (const f of files) {
      for (const m of f.text.matchAll(IDS_BAG)) {
        for (const key of m[1].matchAll(/(?:^|,)\s*([A-Za-z]+Id)\b/g)) if (!ID_KEYS.has(key[1])) bad.add(`${key[1]} (${f.file.slice(root.length + 1)})`)
      }
    }
    expect([...bad]).toEqual([])
  })
})
