// Policy lock: the first-account setup code was removed (2026-11-20, docs/decisions/ui-session-cookie.md).
// `POST /auth/setup` asks for no proof, so no non-test server source may bring the code back.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test(util)?\.tsx?$|\.bun\.test\.tsx?$|\.testutil\.tsx?$/.test(name) ? [path] : []
  })
}

it('no server source mentions the setup code', () => {
  const hits = sources(__dirname).filter((f) => /SETUP_CODE|setupCode|setup_proof_required/.test(readFileSync(f, 'utf8')))
  expect(hits).toEqual([])
})
