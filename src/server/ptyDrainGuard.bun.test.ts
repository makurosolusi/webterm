// Bun-only: the macOS PTY exit deadlock (ptyDrainGuard.ts) reproduced and shown fixed. The event
// loop is blocked on purpose (a synchronous child process) while a PTY child prints and exits, which
// is exactly the window in which Bun's blocking waitpid met a leader stuck in `ttywait`.
import { test, expect, afterAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { spawnPty } from './pty'
import { drainGuardArgv } from './ptyDrainGuard'
import { reapChildren } from './processReap.testutil'

afterAll(() => reapChildren())

const darwin = process.platform === 'darwin'
// Fits in the tty output queue, so the child is not blocked in write: it exits with output unread.
const PRINT_AND_EXIT = `head -c 500 /dev/zero | tr '\\0' x; exit 0`
// cwd '/' on every spawn: the default cwd is $HOME, which an earlier file in the same bun process may have
// pointed at a temp dir it already removed (Bun reports that as ENOENT -> exit 127).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Blocks the event loop ~1 s (nothing reads the PTY master meanwhile), then returns `pid`'s ps state. */
const stateWhileLoopBlocked = (pid: number): string =>
  execFileSync('/bin/sh', ['-c', `sleep 1; ps -o stat= -p ${pid} || echo gone`], { encoding: 'utf8' }).trim()

type RawSpawn = (argv: string[], o: { terminal: { cols: number; rows: number; data: () => void } }) => { pid: number; exited: Promise<number> }

test('unguarded: a PTY leader that exits with unread output is stuck exiting until the master is read', async () => {
  if (!darwin) return // the kernel wait is macOS behaviour
  const raw = (globalThis as unknown as { Bun: { spawn: RawSpawn } }).Bun.spawn
  const proc = raw(['/bin/sh', '-c', PRINT_AND_EXIT], { terminal: { cols: 80, rows: 24, data: () => {} } })
  expect(stateWhileLoopBlocked(proc.pid)).toContain('E') // the hazard: Bun's waitpid on this pid would block forever
  await proc.exited // loop running again: master read, exit completes
}, 20_000)

test('guarded: the leader is still alive (not exiting) while the loop is blocked, and the exit lands once it runs', async () => {
  let out = ''
  let code: number | undefined
  const pty = spawnPty({ cols: 80, rows: 24, cwd: '/', cmd: PRINT_AND_EXIT, shell: '/bin/sh' })
  pty.onData((d) => { out += d })
  pty.onExit((c) => { code = c })
  await sleep(300) // the guard and its child are up
  if (darwin) expect(stateWhileLoopBlocked(pty.pid)).not.toContain('E')
  // Responsive: timers fire and the exit arrives with every byte of output.
  const deadline = Date.now() + 5_000
  while (code === undefined && Date.now() < deadline) await sleep(25)
  expect(code).toBe(0)
  expect(out.split('x').length - 1).toBe(500)
}, 20_000)

test('the guard passes the child exit status through, including signal deaths', async () => {
  const run = async (cmd: string): Promise<number | undefined> => {
    let code: number | undefined
    const pty = spawnPty({ cols: 80, rows: 24, cwd: '/', cmd, shell: '/bin/sh' })
    pty.onExit((c) => { code = c })
    const deadline = Date.now() + 5_000
    while (code === undefined && Date.now() < deadline) await sleep(25)
    return code
  }
  expect(await run('exit 7')).toBe(7)
  expect(await run('kill -9 $$')).toBe(137)
}, 20_000)

test('drainGuardArgv wraps only on macOS with perl, and keeps the argv after `--`', () => {
  const argv = ['/bin/bash', '-l', '-c', 'echo hi']
  expect(drainGuardArgv(argv, 'linux', () => true)).toEqual(argv)
  expect(drainGuardArgv(argv, 'darwin', () => false)).toEqual(argv)
  const wrapped = drainGuardArgv(argv, 'darwin', () => true)
  expect(wrapped.slice(0, 2)).toEqual(['/usr/bin/perl', '-e'])
  expect(wrapped.slice(3)).toEqual(['--', ...argv])
})
