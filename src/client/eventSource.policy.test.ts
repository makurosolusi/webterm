// Policy lock: no client code opens an EventSource. Each one holds an HTTP/1.1 connection for its
// whole life, the browser allows 6 per host across every tab, and with a few streams open every
// further fetch (a settings save) queued forever. Streams go over the shared WebSocket instead:
// `openEventStream` in ws.ts (ws.streams.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const CLIENT = __dirname

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.(?:tsx?|js)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/TestKit\.tsx?$/.test(name) ? [path] : []
  })
}

/** Code only: a comment may mention `new EventSource(` without tripping the lock. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** True when the file opens an EventSource. */
const violates = (text: string): boolean => /\bnew\s+(?:globalThis\.|window\.)?EventSource\s*\(/.test(code(text))

it('the scanner flags an EventSource and ignores comments', () => {
  expect(violates("const s = new EventSource('/api/x')")).toBe(true)
  expect(violates("afterPageLoad(() => new window.EventSource('/x'))")).toBe(true)
  expect(violates("const s = openEventStream('/api/x')")).toBe(false)
  expect(violates('// new EventSource(url) opens the stream')).toBe(false)
})

it('no client code opens an EventSource (streams ride the shared WebSocket)', () => {
  const files = sources(CLIENT)
  expect(files.length).toBeGreaterThan(100) // the walk really saw the client tree
  const found = files.filter((path) => violates(readFileSync(path, 'utf8'))).map((path) => relative(CLIENT, path))
  expect(found).toEqual([])
})
