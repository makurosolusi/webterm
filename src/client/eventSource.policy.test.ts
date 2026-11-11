// Policy lock: a long-lived EventSource opened while the page is still loading keeps the browser
// tab's loading spinner spinning forever. Every client file that creates one must route the
// creation through `afterPageLoad` (src/client/pageLoad.ts).
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

/** True when the file creates an EventSource without importing the page-load gate. */
const violates = (text: string): boolean => {
  const body = code(text)
  return /\bnew EventSource\s*\(/.test(body) && !/import\s*\{[^}]*\bafterPageLoad\b[^}]*\}\s*from\s*['"][./]*pageLoad['"]/.test(body)
}

it('the scanner flags an ungated EventSource and ignores comments', () => {
  expect(violates("const s = new EventSource('/api/x')")).toBe(true)
  expect(violates("import { afterPageLoad } from '../pageLoad'\nafterPageLoad(() => new EventSource('/x'))")).toBe(false)
  expect(violates('// new EventSource(url) opens the stream')).toBe(false)
})

it('every client EventSource is created after page load', () => {
  const files = sources(CLIENT)
  expect(files.length).toBeGreaterThan(100) // the walk really saw the client tree
  const found = files.filter((path) => violates(readFileSync(path, 'utf8'))).map((path) => relative(CLIENT, path))
  expect(found).toEqual([])
})
