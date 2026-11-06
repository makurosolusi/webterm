import { afterEach, expect, it } from 'bun:test'
import { execSync } from 'node:child_process'
import { runCommand } from './verifier'
import type { VerifyExec } from './verify'
import { createProcessExec } from './verifyProcess'

// A marker no other process on the machine carries, so pgrep only ever sees this test's tree.
const MARK = `${37 + (process.pid % 1000) / 1000}`
const survivors = (): number => execSync(`pgrep -f 'sleep ${MARK}' || true`).toString().split('\n').filter(Boolean).length
afterEach(() => { execSync(`pkill -f 'sleep ${MARK}' || true`) })

it('a verify timeout kills the whole tree (npm -> sh -> vitest shape), not only the direct child', async () => {
  // `runCommand` answers from its own deadline; the group kill is the exec's and finishes later. The
  // exec settles only after `close` (every pipe holder in the tree gone), so the wait is on that event.
  const real = createProcessExec()
  let killed: Promise<unknown> = Promise.resolve()
  const exec: VerifyExec = (...a) => { const run = real(...a); killed = Promise.resolve(run); return run }
  const raw = await runCommand({ file: 'sh', args: ['-c', `sleep ${MARK} & sleep ${MARK}; wait`] } as never, '/tmp', exec, { timeoutMs: 400, maxOutputBytes: 4096 }, Date.now)
  expect(raw.evidence.exitCode).toBe(124)
  expect(raw.evidence.summary).toContain('timed out')
  await killed
  expect(survivors()).toBe(0)
})

it('passes exit code and output through; a missing binary reports the cause', async () => {
  const exec = createProcessExec()
  expect(await exec('sh', ['-c', 'echo out; echo err >&2; exit 3'], { cwd: '/tmp', timeoutMs: 5_000, maxOutputBytes: 4096 })).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' })
  const missing = await exec('webterm-no-such-binary', [], { cwd: '/tmp', timeoutMs: 5_000, maxOutputBytes: 4096 })
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain('webterm-no-such-binary')
})

it('output over the cap is truncated and the tree is stopped', async () => {
  const r = await createProcessExec()('sh', ['-c', `yes x & sleep ${MARK}; wait`], { cwd: '/tmp', timeoutMs: 10_000, maxOutputBytes: 2048 })
  expect(r.truncated).toBe(true)
  expect(r.code).toBe(1)
  expect(survivors()).toBe(0) // the exec settles on `close`: every process holding its pipes has exited
})
