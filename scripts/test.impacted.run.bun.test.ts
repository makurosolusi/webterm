import { expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runStep } from './test.impacted.run'

const leftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('webterm-impacted-'))

it('runStep removes its log/home dir once the step is done (ok and failing)', async () => {
  const before = leftovers().length
  const ok = await runStep({ section: 'bun', label: 't', cmd: 'true', args: [], files: [], env: { HOME: '@tmp-home' } }, process.cwd(), false)
  const bad = await runStep({ section: 'bun', label: 't', cmd: 'false', args: [], files: [] }, process.cwd(), false)
  expect([ok.ok, bad.ok]).toEqual([true, false])
  expect(leftovers().length).toBe(before)
})
