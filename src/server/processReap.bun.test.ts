// Bun-only: the test-file reaper really leaves no child behind, including a PTY child that ignores
// SIGTERM (the shape bun's own dangling-process kill can deadlock on).
import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { spawnPty } from './pty'
import { reapChildren } from './processReap.testutil'

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

test('reapChildren kills and waits for every direct child, plain and PTY', async () => {
  const plain = spawn('sleep', ['30'], { stdio: 'ignore' })
  let out = ''
  const pty = spawnPty({ cols: 80, rows: 24, cmd: `trap '' TERM; echo READY; sleep 30`, shell: '/bin/sh' })
  pty.onData((d) => { out += d })
  const deadline = Date.now() + 10_000
  while (!out.includes('READY') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  expect(out).toContain('READY')
  expect(alive(plain.pid!) && alive(pty.pid)).toBe(true)

  await reapChildren()
  expect(alive(plain.pid!)).toBe(false) // gone AND reaped: a zombie would still answer kill(0)
  expect(alive(pty.pid)).toBe(false)
  await reapChildren() // nothing left: returns at once
}, 20_000)
