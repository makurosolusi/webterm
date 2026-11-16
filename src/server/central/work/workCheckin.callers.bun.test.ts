// Policy: every producer of a check-in reason decides where the check-in lands. A new caller without a decision fails here.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SERVER = join(__dirname, '..', '..')
const CALL = 'queueCheckinReason('
/** Callers that pass no origin on purpose, each with the reason. */
const ALLOWED_WITHOUT_ORIGIN: Record<string, string> = {
  'central/work/workCheckin.ts': 'the definition, and the engine enqueue helper that takes conversationId as a parameter',
  'central/health/healthNotify.ts': 'scans are system signals with no asking chat; they route by project, then global',
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.(bun\.)?test\.|\.testutil\./.test(name) ? [path] : []
  })
}

test('every queueCheckinReason caller passes conversationId or is allowlisted with a reason', () => {
  const callers = sources(SERVER).map((f) => relative(SERVER, f)).filter((f) => readFileSync(join(SERVER, f), 'utf8').includes(CALL))
  const passes = (f: string): boolean => readFileSync(join(SERVER, f), 'utf8').split(CALL).slice(1).every((rest) => /conversationId/.test(rest.slice(0, 900)))
  expect(callers.filter((f) => !(f in ALLOWED_WITHOUT_ORIGIN) && !passes(f))).toEqual([])
  expect(callers.length).toBeGreaterThan(4) // the scan itself still finds the callers
})
