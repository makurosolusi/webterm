// ops-212-1: an unhandled rejection is logged with its cause and exits 1, never a silent code 0.
import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { onUncaughtExceptionMonitor, onUnhandledRejection, UNHANDLED_REJECTION_EXIT_CODE } from './processCrash'

test('the handler logs the cause and exits with code 1', () => {
  const lines: string[] = []
  const codes: number[] = []
  const handler = onUnhandledRejection({ error: (event, message) => void lines.push(`${event} ${message}`) }, (c) => void codes.push(c))
  handler(new Error('ENOENT asset'))
  expect(codes).toEqual([UNHANDLED_REJECTION_EXIT_CODE])
  expect(lines[0]).toContain('server.unhandled_rejection')
  expect(lines[0]).toContain('Error: ENOENT asset')
})

test('a real process with the handler installed exits 1 and the exit hook sees 1', () => {
  const mod = join(import.meta.dirname, 'processCrash.ts')
  const script = `
    const { onUnhandledRejection } = await import(${JSON.stringify(mod)})
    process.on('unhandledRejection', onUnhandledRejection({ error: (e, m) => console.log(e, m) }))
    process.on('exit', (code) => console.log('exit-hook', code))
    Promise.reject(new Error('boom'))
    setTimeout(() => console.log('still-alive'), 2000)
  `
  const p = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  const out = p.stdout
  expect(p.status).toBe(1)
  expect(out).toContain('server.unhandled_rejection')
  expect(out).toContain('exit-hook 1')
  expect(out).not.toContain('still-alive')
})

test('an uncaught exception is logged and flushed before any exit hook could run', () => {
  const steps: string[] = []
  const monitor = onUncaughtExceptionMonitor({ error: (event, message) => void steps.push(`${event} ${message}`) }, () => void steps.push('flush'))
  monitor(new TypeError('boom'))
  expect(steps).toEqual(['server.error Uncaught exception: TypeError: boom', 'flush'])
})

test('a host that exits natively on uncaughtException (Electrobun) still gets the line on disk', () => {
  const mod = join(import.meta.dirname, 'processCrash.ts')
  // reallyExit = native exit without the `exit` hook, like Electrobun's forceExit; the "log" is a buffer.
  const script = `
    const { onUncaughtExceptionMonitor } = await import(${JSON.stringify(mod)})
    const buffered = []
    process.on('uncaughtExceptionMonitor', onUncaughtExceptionMonitor({ error: (e, m) => buffered.push(e + ' ' + m) }, () => { console.log(buffered.join('\\n')); buffered.length = 0 }))
    process.on('uncaughtException', () => process.reallyExit(1))
    process.on('exit', () => console.log('exit-hook'))
    setTimeout(() => { throw new Error('boom') }, 0)
  `
  const p = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  expect(p.status).toBe(1)
  expect(p.stdout).toContain('server.error Uncaught exception: Error: boom')
  expect(p.stdout).not.toContain('exit-hook')
})
