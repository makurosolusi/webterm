// Policy lock: the command registry is the one source of command labels and chords. Every bound
// command carries its English label (and so a category); menus and hints read a chord through the
// registry (`useCommandShortcut`, `chordLabel`) instead of writing a platform label by hand, so a
// rebinding can never leave a stale "⇧⌘U" behind.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { commandCategory, listCommands } from './commandRegistry'
import { INDEXED_COMMANDS } from './settings.search'

const CLIENT = __dirname
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const files = sources(CLIENT).map((path) => ({ file: relative(CLIENT, path), text: code(readFileSync(path, 'utf8')) }))

/** The `{…}` object literal around `at`, braces balanced both ways. */
function objectAround(text: string, at: number): string {
  let start = at
  for (let depth = 0; start > 0; start--) {
    if (text[start] === '}') depth++
    else if (text[start] === '{' && depth-- === 0) break
  }
  let end = at
  for (let depth = 0; end < text.length; end++) {
    if (text[end] === '{') depth++
    else if (text[end] === '}' && depth-- === 0) break
  }
  return text.slice(start, end + 1)
}

it('every registered command with a chord has a label and a category', () => {
  const all = [...INDEXED_COMMANDS, ...listCommands()]
  expect(all.length).toBeGreaterThan(30)
  for (const c of all.filter((x) => x.defaultKey)) {
    expect(c.label.trim(), c.id).not.toBe('')
    expect(commandCategory(c), c.id).toBeTruthy()
  }
})

it('every command literal with a defaultKey in the client source declares its label', () => {
  const missing = files.flatMap(({ file, text }) =>
    [...text.matchAll(/\bdefaultKey:/g)].map((m) => objectAround(text, m.index)).filter((o) => !/\blabel:/.test(o)).map((o) => `${file}: ${o.slice(0, 80)}`))
  expect(files.length).toBeGreaterThan(100)
  expect(missing).toEqual([])
})

/** Hand-written `isMac ? '⇧⌘U' : 'Ctrl+Shift+U'` chord labels; these files label gestures, not commands. */
const GESTURE_FILES = new Set(['quickDrag/quickDrag.modifier.ts'])
it('no hand-written platform chord labels: read the chord from the registry', () => {
  const hand = files.filter(({ file, text }) => !GESTURE_FILES.has(file) && /\?\s*'[⌘⇧⌥⌃][^']*'\s*:\s*'(?:Ctrl|Alt|Shift)/.test(text)).map((f) => f.file)
  expect(hand).toEqual([])
  for (const f of GESTURE_FILES) expect(files.some((x) => x.file === f), f).toBe(true) // no stale entry
})
