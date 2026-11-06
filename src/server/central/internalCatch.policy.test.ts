// Policy lock (audit B4): a catch that turns an exception into an internal/500 answer must log the
// cause first. Otherwise the operator sees a context-free 500 and the real error is gone.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const SERVER = join(__dirname, '..')
const ROOTS = ['central', 'orchestrator']
const BOUNDARY_FILES = ['orchestratorRunApi.ts', 'centralAutonomyBoot.ts', 'centralChatHandlers.ts']
const INTERNAL_ANSWER = /'internal'|_internal'|status:\s*500/
const LOGS = /\blog(?:ger)?\.(?:error|warn)\(/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** Bodies of every `catch (...) { ... }` / `catch { ... }` block, matched by brace depth. */
function catchBodies(text: string): { line: number; body: string }[] {
  const found: { line: number; body: string }[] = []
  for (const m of text.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    let depth = 1
    let i = (m.index ?? 0) + m[0].length
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') depth -= 1
      i += 1
    }
    found.push({ line: text.slice(0, m.index).split('\n').length, body: text.slice(start, i - 1) })
  }
  return found
}

it('the scanner sees a log-less internal catch and accepts a logged one', () => {
  expect(catchBodies("try { a() } catch { return { status: 500, body: { error: 'internal' } } }")[0]?.body).toMatch(INTERNAL_ANSWER)
  const logged = catchBodies("try { a() } catch (err) { log.error('x', 'y', { err }); return fail('internal') }")[0]?.body ?? ''
  expect(LOGS.test(logged)).toBe(true)
})

it('every catch in central/, orchestrator/ and the run/chat boundaries that answers internal/500 logs the cause', () => {
  const files = [...ROOTS.flatMap((r) => sources(join(SERVER, r))), ...BOUNDARY_FILES.map((f) => join(SERVER, f))]
  const offenders = files.flatMap((file) =>
    catchBodies(readFileSync(file, 'utf8'))
      .filter(({ body }) => INTERNAL_ANSWER.test(body) && !LOGS.test(body))
      .map(({ line }) => `${relative(SERVER, file)}:${line}`)
  )
  expect(offenders).toEqual([])
})
